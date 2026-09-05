import os
import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PLUGIN_ROOT / "scripts"
if str(SCRIPTS_DIR) not in os.sys.path:
    os.sys.path.insert(0, str(SCRIPTS_DIR))

import install_system_proxy_codex as installer


class FakeCommandRunner:
    def __init__(self, marketplace_exists):
        """创建记录命令的假 Codex 运行器。"""

        self.marketplace_exists = marketplace_exists
        self.commands = []

    def json(self, arguments):
        """返回 marketplace 列表的假 JSON 输出。"""

        self.commands.append(tuple(arguments))
        if arguments[:3] == ["plugin", "marketplace", "list"]:
            marketplaces = [{"name": "codex-toolshop"}] if self.marketplace_exists else []
            return {"marketplaces": marketplaces}
        raise AssertionError(arguments)

    def run(self, arguments):
        """记录普通 Codex 命令并模拟成功。"""

        self.commands.append(tuple(arguments))
        return ""


class PluginInstallTest(unittest.TestCase):
    def test_inspection_does_not_install_enable_or_write_configuration(self):
        """只读诊断通过真实参数入口运行，不安装插件、不启用功能、不写配置。"""
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "codex-home"
            runner = mock.Mock(executable="codex-test")
            client = mock.Mock()
            client.version.return_value = "0.146.1"
            client.feature_enabled.return_value = False
            with mock.patch.object(installer, "CommandRunner", return_value=runner), \
                    mock.patch.object(installer, "CodexClient", return_value=client), \
                    mock.patch.object(installer, "install_plugin") as install, \
                    mock.patch.object(installer, "ensure_feature") as enable, \
                    contextlib.redirect_stdout(io.StringIO()):
                code = installer.main(["--codex-home", str(home), "--dry-run",
                                       "--port", "7890"])
            self.assertEqual(code, 0)
            self.assertFalse(home.exists())
            install.assert_not_called()
            enable.assert_not_called()
            runner.run.assert_not_called()

    def test_existing_marketplace_is_upgraded_then_plugin_is_refreshed(self):
        """验证已有 marketplace 先升级再刷新插件。"""

        runner = FakeCommandRunner(marketplace_exists=True)

        installer.install_plugin(runner)

        self.assertIn(("plugin", "marketplace", "upgrade", "codex-toolshop"), runner.commands)
        self.assertEqual(
            ("plugin", "add", "system-proxy-codex@codex-toolshop"), runner.commands[-1]
        )

    def test_missing_marketplace_is_added(self):
        """验证缺失 marketplace 时使用官方仓库地址添加。"""

        runner = FakeCommandRunner(marketplace_exists=False)

        installer.install_plugin(runner)

        self.assertIn(
            (
                "plugin",
                "marketplace",
                "add",
                "https://github.com/IBinary6/codex-toolshop.git",
            ),
            runner.commands,
        )

    def test_install_failure_is_not_reported_as_success(self):
        """验证 marketplace 中途失败会向调用者传播。"""

        runner = FakeCommandRunner(marketplace_exists=True)

        def fail_upgrade(arguments):
            """模拟 marketplace 升级失败。"""

            raise installer.InstallError("upgrade failed")

        runner.run = fail_upgrade
        with self.assertRaisesRegex(installer.InstallError, "upgrade failed"):
            installer.install_plugin(runner)


if __name__ == "__main__":
    unittest.main()
