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
        """Verify a custom port maps to a unified local proxy."""

        settings = setup_proxy.resolve_proxy_settings(port=7890)

        self.assertEqual("http://127.0.0.1:7890", settings.http)
        self.assertEqual(settings.http, settings.https)
        self.assertEqual(settings.http, settings.all_proxy)
        self.assertEqual("explicit-port", settings.source)

    def test_explicit_url_takes_precedence_without_detection(self):
        """Verify explicit URLs do not trigger system discovery."""

        with mock.patch.object(setup_proxy, "detect_system_proxy") as detect:
            settings = setup_proxy.resolve_proxy_settings(
                proxy_url="http://192.168.1.10:7890"
            )

        detect.assert_not_called()
        self.assertEqual("http://192.168.1.10:7890", settings.https)

    def test_default_7897_requires_a_listening_proxy(self):
        """Verify unreachable default port 7897 prevents configuration writes."""

        with mock.patch.object(setup_proxy, "detect_system_proxy", return_value=None):
            with mock.patch.object(setup_proxy, "proxy_is_reachable", return_value=False):
                with self.assertRaisesRegex(setup_proxy.ProxySetupError, "7897"):
                    setup_proxy.resolve_proxy_settings(validate_connection=True)

    def test_encoded_credentials_are_not_double_encoded(self):
        """Verify existing percent-encoding remains canonical in authenticated proxies."""

        normalized = setup_proxy.normalize_proxy_url(
            "http://user%40corp:p%40ss@127.0.0.1:7890"
        )

        self.assertEqual("http://user%40corp:p%40ss@127.0.0.1:7890", normalized)
        self.assertEqual("http://***@127.0.0.1:7890", setup_proxy.redact_proxy_url(normalized))

    def test_invalid_port_is_rejected(self):
        """Verify port boundaries do not produce invalid proxies."""

        for port in (0, 65536):
            with self.subTest(port=port):
                with self.assertRaisesRegex(setup_proxy.ProxySetupError, "1 and 65535"):
                    setup_proxy.resolve_proxy_settings(port=port)
        with self.assertRaisesRegex(setup_proxy.ProxySetupError, "1 and 65535"):
            setup_proxy.resolve_proxy_settings(proxy_url="http://127.0.0.1:0")

    def test_port_and_protocol_urls_are_mutually_exclusive(self):
        """Verify a simple port cannot be combined with per-protocol URLs."""

        parser = setup_proxy.build_parser()
        args = parser.parse_args(["--port", "7890", "--http-proxy-url", "http://127.0.0.1:7891"])

        with self.assertRaisesRegex(setup_proxy.ProxySetupError, "cannot"):
            setup_proxy.validate_arguments(args)


class PlatformDetectionTest(unittest.TestCase):
    def test_windows_proxy_override_is_converted_to_no_proxy(self):
        """Verify Windows bypass lists become safe NO_PROXY entries."""

        bypass = setup_proxy.parse_windows_proxy_override(
            "<local>;*.corp.example;10.0.0.8;printer;10.*"
        )

        self.assertIn(".corp.example", bypass)
        self.assertIn("10.0.0.8", bypass)
        self.assertIn("printer", bypass)
        self.assertNotIn("<local>", bypass)
        self.assertNotIn("10.*", bypass)

    def test_windows_detection_reads_proxy_override(self):
        """Verify Windows registry discovery also reads ProxyOverride."""

        class FakeKey:
            """Provide the minimal winreg context manager interface."""

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        fake_winreg = mock.Mock()
        fake_winreg.HKEY_CURRENT_USER = object()
        fake_winreg.OpenKey.return_value = FakeKey()
        values = {
            "ProxyEnable": (1, 0),
            "ProxyServer": ("127.0.0.1:7890", 0),
            "ProxyOverride": ("*.corp.example;printer", 0),
        }
        fake_winreg.QueryValueEx.side_effect = lambda _, name: values[name]

        with mock.patch.dict(os.sys.modules, {"winreg": fake_winreg}):
            settings = setup_proxy.detect_windows_proxy()

        self.assertIn(".corp.example", settings.no_proxy)
        self.assertIn("printer", settings.no_proxy)

    def test_windows_single_proxy_uses_uniform_endpoint(self):
        """Verify a Windows single-address proxy produces a general proxy."""

        settings = setup_proxy.parse_windows_proxy_server("127.0.0.1:7890")

        self.assertIsNotNone(settings)
        self.assertEqual("http://127.0.0.1:7890", settings.all_proxy)

    def test_windows_split_proxy_does_not_invent_all_proxy(self):
        """Verify split Windows proxies do not infer ALL_PROXY."""

        settings = setup_proxy.parse_windows_proxy_server(
            "http=127.0.0.1:7890;https=127.0.0.1:7891"
        )

        self.assertEqual("http://127.0.0.1:7890", settings.http)
        self.assertEqual("http://127.0.0.1:7891", settings.https)
        self.assertIsNone(settings.all_proxy)

    def test_macos_static_proxy_is_parsed(self):
        """Verify macOS static proxy output can be parsed."""

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
        """Verify lowercase Linux proxy variables are supported."""

        settings = setup_proxy.detect_environment_proxy(
            {"http_proxy": "127.0.0.1:7890", "no_proxy": "example.test"}
        )

        self.assertEqual("http://127.0.0.1:7890", settings.http)
        self.assertIn("example.test", settings.no_proxy)

    def test_empty_environment_does_not_fall_back_to_process_values(self):
        """Verify an explicit empty environment does not inherit test process variables."""

        self.assertIsNone(setup_proxy.detect_environment_proxy({}))

    def test_unsupported_all_proxy_does_not_discard_valid_http_proxy(self):
        """Verify SOCKS ALL_PROXY does not mask a valid HTTP_PROXY."""

        settings = setup_proxy.detect_environment_proxy(
            {
                "HTTP_PROXY": "http://127.0.0.1:7890",
                "ALL_PROXY": "socks5://127.0.0.1:7891",
            }
        )

        self.assertEqual("http://127.0.0.1:7890", settings.http)
        self.assertIsNone(settings.all_proxy)

    def test_gnome_manual_proxy_is_detected(self):
        """Verify automatic discovery of GNOME manual proxies."""

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
        """Verify manual proxies in KDE configuration files are discovered."""

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
        """Verify the common space-separated KDE host/port format."""

        self.assertEqual(
            "http://www.google.com:80",
            setup_proxy.normalize_proxy_url("www.google.com 80"),
        )


class EnvMergeTest(unittest.TestCase):
    def test_merge_preserves_unrelated_values_and_updates_proxy(self):
        """Verify merging preserves secrets, line endings, and legacy WSS keys."""

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
        """Verify idempotent runs do not create redundant backups."""

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
        """Verify split proxies remove unsafe legacy general proxy settings."""

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
        """Verify dry-run reports changes without creating files."""

        with tempfile.TemporaryDirectory() as temp:
            codex_home = Path(temp)
            settings = setup_proxy.ProxySettings.uniform(
                "http://127.0.0.1:7897", source="test"
            )

            result = setup_proxy.merge_env_file(codex_home, settings, dry_run=True)

            self.assertTrue(result.changed)
            self.assertFalse((codex_home / ".env").exists())

    def test_failed_post_write_verification_restores_original(self):
        """Verify failed post-replacement validation restores the original .env."""

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
                """Pass pre-write validation and fail post-write validation."""

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
        """Verify failed rollback preserves a preexisting empty .env."""

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
                """Fail post-write validation for the empty-file case."""

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
        """Verify explicit CODEX_HOME does not fall back to the user home."""

        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(Path(temp).resolve(), setup_proxy.codex_home_from_env(temp))

    def test_cli_reports_filesystem_failure_without_traceback(self):
        """Verify CLI filesystem failures identify the failing stage."""

        stderr = io.StringIO()
        settings = setup_proxy.ProxySettings.uniform(
            "http://127.0.0.1:7897", source="test"
        )
        with mock.patch.object(setup_proxy, "resolve_proxy_settings", return_value=settings):
            with mock.patch.object(setup_proxy, "merge_env_file", side_effect=OSError("denied")):
                with contextlib.redirect_stderr(stderr):
                    result = setup_proxy.main(["--proxy-url", "http://127.0.0.1:7897"])

        self.assertEqual(2, result)
        self.assertIn(".env file operation failed", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
