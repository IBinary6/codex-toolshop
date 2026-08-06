import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PLUGIN_ROOT / "scripts"
if str(SCRIPTS_DIR) not in os.sys.path:
    os.sys.path.insert(0, str(SCRIPTS_DIR))

import setup_proxy


class ResolveProxySettingsTest(unittest.TestCase):
    def test_port_builds_loopback_proxy(self):
        """验证自定义端口映射到本机统一代理。"""

        settings = setup_proxy.resolve_proxy_settings(port=7890)

        self.assertEqual("http://127.0.0.1:7890", settings.http)
        self.assertEqual(settings.http, settings.https)
        self.assertEqual(settings.http, settings.all_proxy)
        self.assertEqual("explicit-port", settings.source)

    def test_explicit_url_takes_precedence_without_detection(self):
        """验证显式 URL 不会触发系统自动检测。"""

        with mock.patch.object(setup_proxy, "detect_system_proxy") as detect:
            settings = setup_proxy.resolve_proxy_settings(
                proxy_url="http://192.168.1.10:7890"
            )

        detect.assert_not_called()
        self.assertEqual("http://192.168.1.10:7890", settings.https)

    def test_default_7897_requires_a_listening_proxy(self):
        """验证默认 7897 不可连接时拒绝写配置。"""

        with mock.patch.object(setup_proxy, "detect_system_proxy", return_value=None):
            with mock.patch.object(setup_proxy, "proxy_is_reachable", return_value=False):
                with self.assertRaisesRegex(setup_proxy.ProxySetupError, "7897"):
                    setup_proxy.resolve_proxy_settings(validate_connection=True)

    def test_encoded_credentials_are_not_double_encoded(self):
        """验证认证代理中已有的百分号编码保持规范。"""

        normalized = setup_proxy.normalize_proxy_url(
            "http://user%40corp:p%40ss@127.0.0.1:7890"
        )

        self.assertEqual("http://user%40corp:p%40ss@127.0.0.1:7890", normalized)
        self.assertEqual("http://***@127.0.0.1:7890", setup_proxy.redact_proxy_url(normalized))

    def test_invalid_port_is_rejected(self):
        """验证端口边界不会产生无效代理。"""

        for port in (0, 65536):
            with self.subTest(port=port):
                with self.assertRaisesRegex(setup_proxy.ProxySetupError, "1 到 65535"):
                    setup_proxy.resolve_proxy_settings(port=port)
        with self.assertRaisesRegex(setup_proxy.ProxySetupError, "1 到 65535"):
            setup_proxy.resolve_proxy_settings(proxy_url="http://127.0.0.1:0")

    def test_port_and_protocol_urls_are_mutually_exclusive(self):
        """验证简化端口不能与分协议 URL 同时使用。"""

        parser = setup_proxy.build_parser()
        args = parser.parse_args(["--port", "7890", "--http-proxy-url", "http://127.0.0.1:7891"])

        with self.assertRaisesRegex(setup_proxy.ProxySetupError, "不能"):
            setup_proxy.validate_arguments(args)


class PlatformDetectionTest(unittest.TestCase):
    def test_windows_single_proxy_uses_uniform_endpoint(self):
        """验证 Windows 单地址代理会生成通用代理。"""

        settings = setup_proxy.parse_windows_proxy_server("127.0.0.1:7890")

        self.assertIsNotNone(settings)
        self.assertEqual("http://127.0.0.1:7890", settings.all_proxy)

    def test_windows_split_proxy_does_not_invent_all_proxy(self):
        """验证 Windows 分离代理不会猜测 ALL_PROXY。"""

        settings = setup_proxy.parse_windows_proxy_server(
            "http=127.0.0.1:7890;https=127.0.0.1:7891"
        )

        self.assertEqual("http://127.0.0.1:7890", settings.http)
        self.assertEqual("http://127.0.0.1:7891", settings.https)
        self.assertIsNone(settings.all_proxy)

    def test_macos_static_proxy_is_parsed(self):
        """验证 macOS 静态代理输出可以解析。"""

        settings = setup_proxy.parse_scutil_proxy(
            """
            <dictionary> {
              HTTPEnable : 1
              HTTPPort : 7890
              HTTPProxy : 127.0.0.1
              HTTPSEnable : 1
              HTTPSPort : 7890
              HTTPSProxy : 127.0.0.1
              ExceptionsList : <array> {
                0 : example.test
              }
            }
            """
        )

        self.assertEqual("http://127.0.0.1:7890", settings.all_proxy)
        self.assertIn("example.test", settings.no_proxy)

    def test_linux_environment_supports_lowercase_names(self):
        """验证 Linux 小写标准代理变量受到支持。"""

        settings = setup_proxy.detect_environment_proxy(
            {"http_proxy": "127.0.0.1:7890", "no_proxy": "example.test"}
        )

        self.assertEqual("http://127.0.0.1:7890", settings.http)
        self.assertIn("example.test", settings.no_proxy)

    def test_empty_environment_does_not_fall_back_to_process_values(self):
        """验证显式空环境不会泄漏测试进程变量。"""

        self.assertIsNone(setup_proxy.detect_environment_proxy({}))

    def test_unsupported_all_proxy_does_not_discard_valid_http_proxy(self):
        """验证 SOCKS ALL_PROXY 不会遮蔽有效 HTTP_PROXY。"""

        settings = setup_proxy.detect_environment_proxy(
            {
                "HTTP_PROXY": "http://127.0.0.1:7890",
                "ALL_PROXY": "socks5://127.0.0.1:7891",
            }
        )

        self.assertEqual("http://127.0.0.1:7890", settings.http)
        self.assertIsNone(settings.all_proxy)

    def test_gnome_manual_proxy_is_detected(self):
        """验证 GNOME 手动代理可以自动检测。"""

        values = {
            ("gsettings", "get", "org.gnome.system.proxy", "mode"): "'manual'",
            ("gsettings", "get", "org.gnome.system.proxy.http", "host"): "'127.0.0.1'",
            ("gsettings", "get", "org.gnome.system.proxy.http", "port"): "7890",
            ("gsettings", "get", "org.gnome.system.proxy.https", "host"): "'127.0.0.1'",
            ("gsettings", "get", "org.gnome.system.proxy.https", "port"): "7890",
            ("gsettings", "get", "org.gnome.system.proxy", "ignore-hosts"): "['example.test']",
        }
        with mock.patch.object(
            setup_proxy, "_run_text", side_effect=lambda command, **_: values.get(tuple(command))
        ):
            settings = setup_proxy.detect_gnome_proxy()

        self.assertEqual("http://127.0.0.1:7890", settings.all_proxy)
        self.assertIn("example.test", settings.no_proxy)

    def test_kde_manual_proxy_file_is_detected(self):
        """验证 KDE 配置文件中的手动代理可以检测。"""

        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            config = home / ".config" / "kioslaverc"
            config.parent.mkdir(parents=True)
            config.write_text(
                "[Proxy Settings]\nProxyType=1\n"
                "httpProxy=http://127.0.0.1:7890\n"
                "httpsProxy=http://127.0.0.1:7890\n",
                encoding="utf-8",
            )
            with mock.patch.object(setup_proxy.shutil, "which", return_value=None):
                with mock.patch.object(setup_proxy.Path, "home", return_value=home):
                    settings = setup_proxy.detect_kde_proxy()

        self.assertEqual("http://127.0.0.1:7890", settings.all_proxy)

    def test_kde_space_separated_host_and_port_is_supported(self):
        """验证 KDE 常见的空格分隔主机端口格式。"""

        self.assertEqual(
            "http://www.google.com:80",
            setup_proxy.normalize_proxy_url("www.google.com 80"),
        )


class EnvMergeTest(unittest.TestCase):
    def test_merge_preserves_unrelated_values_and_updates_proxy(self):
        """验证合并保留密钥、换行风格和旧 WSS 键。"""

        with tempfile.TemporaryDirectory() as temp:
            codex_home = Path(temp)
            env_file = codex_home / ".env"
            env_file.write_text(
                '# keep\r\nOPENAI_API_KEY="secret"\r\n'
                'http_proxy="http://127.0.0.1:7897"\r\n'
                'HTTP_PROXY="duplicate"\r\n'
                'wss_proxy="http://127.0.0.1:7897"\r\n'
                'NO_PROXY="example.com,localhost"\r\n',
                encoding="utf-8",
                newline="",
            )
            settings = setup_proxy.ProxySettings.uniform(
                "http://127.0.0.1:7890", source="test"
            )

            result = setup_proxy.merge_env_file(codex_home, settings)
            with env_file.open("r", encoding="utf-8", newline="") as stream:
                content = stream.read()

            self.assertTrue(result.changed)
            self.assertIn('OPENAI_API_KEY="secret"', content)
            self.assertIn('HTTP_PROXY="http://127.0.0.1:7890"', content)
            self.assertEqual(1, content.count("HTTP_PROXY="))
            self.assertIn('wss_proxy="http://127.0.0.1:7897"', content)
            self.assertIn("example.com", content)
            self.assertIn("127.0.0.1", content)
            self.assertIn("\r\n", content)
            self.assertIsNotNone(result.backup_path)
            self.assertTrue(result.backup_path.exists())
            if os.name != "nt":
                self.assertEqual(0, result.backup_path.stat().st_mode & 0o077)

    def test_unchanged_content_does_not_create_backup(self):
        """验证幂等运行不会制造多余备份。"""

        with tempfile.TemporaryDirectory() as temp:
            codex_home = Path(temp)
            settings = setup_proxy.ProxySettings.uniform(
                "http://127.0.0.1:7897", source="test"
            )
            setup_proxy.merge_env_file(codex_home, settings)

            result = setup_proxy.merge_env_file(codex_home, settings)

            self.assertFalse(result.changed)
            self.assertIsNone(result.backup_path)

    def test_split_proxy_removes_stale_all_proxy(self):
        """验证分离代理会清理危险的旧通用代理。"""

        with tempfile.TemporaryDirectory() as temp:
            codex_home = Path(temp)
            (codex_home / ".env").write_text(
                'ALL_PROXY="http://127.0.0.1:7897"\n', encoding="utf-8"
            )
            settings = setup_proxy.ProxySettings(
                "http://127.0.0.1:7890",
                "http://127.0.0.1:7891",
                None,
                source="test",
            )

            setup_proxy.merge_env_file(codex_home, settings)

            content = (codex_home / ".env").read_text(encoding="utf-8")
            self.assertNotIn("ALL_PROXY", content)

    def test_dry_run_reports_change_without_writing(self):
        """验证 dry-run 报告变化但不创建文件。"""

        with tempfile.TemporaryDirectory() as temp:
            codex_home = Path(temp)
            settings = setup_proxy.ProxySettings.uniform(
                "http://127.0.0.1:7897", source="test"
            )

            result = setup_proxy.merge_env_file(codex_home, settings, dry_run=True)

            self.assertTrue(result.changed)
            self.assertFalse((codex_home / ".env").exists())

    def test_failed_post_write_verification_restores_original(self):
        """验证替换后校验失败会恢复原 `.env`。"""

        with tempfile.TemporaryDirectory() as temp:
            codex_home = Path(temp)
            env_file = codex_home / ".env"
            original = 'OPENAI_API_KEY="secret"\n'
            env_file.write_text(original, encoding="utf-8")
            settings = setup_proxy.ProxySettings.uniform(
                "http://127.0.0.1:7897", source="test"
            )
            real_verify = setup_proxy._verify_env
            calls = 0

            def fail_second_verification(content, requested):
                """让写入前校验成功、写入后校验失败。"""

                nonlocal calls
                calls += 1
                if calls == 2:
                    raise setup_proxy.ProxySetupError("forced verification failure")
                return real_verify(content, requested)

            with mock.patch.object(setup_proxy, "_verify_env", side_effect=fail_second_verification):
                with self.assertRaisesRegex(setup_proxy.ProxySetupError, "forced"):
                    setup_proxy.merge_env_file(codex_home, settings)

            self.assertEqual(original, env_file.read_text(encoding="utf-8"))

    def test_failed_verification_preserves_an_existing_empty_env_file(self):
        """验证失败回滚不会删除原本存在的空 `.env`。"""

        with tempfile.TemporaryDirectory() as temp:
            codex_home = Path(temp)
            env_file = codex_home / ".env"
            env_file.write_bytes(b"")
            settings = setup_proxy.ProxySettings.uniform(
                "http://127.0.0.1:7897", source="test"
            )
            real_verify = setup_proxy._verify_env
            calls = 0

            def fail_second_verification(content, requested):
                """让空文件场景的写入后校验失败。"""

                nonlocal calls
                calls += 1
                if calls == 2:
                    raise setup_proxy.ProxySetupError("forced verification failure")
                return real_verify(content, requested)

            with mock.patch.object(setup_proxy, "_verify_env", side_effect=fail_second_verification):
                with self.assertRaisesRegex(setup_proxy.ProxySetupError, "forced"):
                    setup_proxy.merge_env_file(codex_home, settings)

            self.assertTrue(env_file.exists())
            self.assertEqual(b"", env_file.read_bytes())

    def test_custom_codex_home_is_resolved(self):
        """验证显式 CODEX_HOME 不会回落到用户主目录。"""

        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(Path(temp).resolve(), setup_proxy.codex_home_from_env(temp))

    def test_cli_reports_filesystem_failure_without_traceback(self):
        """验证 CLI 把文件系统异常转换为明确阶段错误。"""

        stderr = io.StringIO()
        settings = setup_proxy.ProxySettings.uniform(
            "http://127.0.0.1:7897", source="test"
        )
        with mock.patch.object(setup_proxy, "resolve_proxy_settings", return_value=settings):
            with mock.patch.object(setup_proxy, "merge_env_file", side_effect=OSError("denied")):
                with contextlib.redirect_stderr(stderr):
                    result = setup_proxy.main(["--proxy-url", "http://127.0.0.1:7897"])

        self.assertEqual(2, result)
        self.assertIn(".env 文件操作失败", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
