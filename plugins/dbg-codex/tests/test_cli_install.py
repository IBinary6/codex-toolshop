from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import cli_install  # noqa: E402
import dbg_core  # noqa: E402


class FakeContext:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.backup_dir = data_dir / "backups"
        self.state: dict[str, object] = {}
        self.saves = 0

    def stage(self, name: str, version: str) -> Path:
        path = self.data_dir / "staging" / name / version
        path.mkdir(parents=True, exist_ok=True)
        return path

    def deploy(self, files: dict[Path, Path]) -> list[str]:
        return dbg_core.managed_deploy(files, self.state, self.backup_dir)

    def save(self) -> None:
        self.saves += 1


class FakeRegistry:
    def __init__(self, value: str | None = None, kind: int | None = None) -> None:
        self.value = value
        self.kind = kind
        self.writes: list[tuple[str, int]] = []
        self.broadcasts = 0

    def read_path(self) -> tuple[str, int] | None:
        if self.value is None or self.kind is None:
            return None
        return self.value, self.kind

    def write_path(self, value: str, kind: int) -> None:
        self.value = value
        self.kind = kind
        self.writes.append((value, kind))

    def broadcast_environment_change(self) -> bool:
        self.broadcasts += 1
        return True


class CliInstallTests(unittest.TestCase):
    def _inputs(self, root: Path) -> tuple[FakeContext, Path, Path]:
        context = FakeContext(root / "data")
        node = root / "Node 目录" / "node.exe"
        launcher = root / "插件 目录" / "launch.cjs"
        node.parent.mkdir(parents=True)
        launcher.parent.mkdir(parents=True)
        node.write_bytes(b"node")
        launcher.write_text("// launch", encoding="utf-8")
        return context, launcher, node

    def test_windows_installs_quoted_cmd_and_preserves_registry_type(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            registry = FakeRegistry(r"C:\Tools", cli_install.REG_EXPAND_SZ)

            result = cli_install.install_cli(
                context,
                launcher,
                node,
                os_name="nt",
                home=root / "home",
                registry=registry,
            )

            target = context.data_dir / "bin" / "dbg.cmd"
            self.assertEqual(result["target"], str(target))
            self.assertTrue(result["changed"])
            self.assertTrue(result["path_changed"])
            self.assertEqual(registry.writes[0][1], cli_install.REG_EXPAND_SZ)
            self.assertEqual(registry.broadcasts, 1)
            self.assertEqual(
                target.read_text(encoding="utf-8"),
                "@%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe "
                "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass "
                "-File \"%~dp0dbg-cli.ps1\" %*\n"
                "@exit /b %ERRORLEVEL%\n",
            )
            companion = target.with_name("dbg-cli.ps1")
            self.assertTrue(target.read_bytes().isascii())
            self.assertTrue(companion.read_bytes().startswith(b"\xef\xbb\xbf"))
            self.assertEqual(
                companion.read_text(encoding="utf-8-sig"),
                "param(\n"
                "    [Parameter(ValueFromRemainingArguments = $true)]\n"
                "    [string[]] $DbgArgs\n"
                ")\n"
                f"& '{node.resolve()}' '{launcher.resolve()}' @DbgArgs\n"
                "exit $LASTEXITCODE\n",
            )
            self.assertTrue(registry.value.endswith(";" + str(target.parent)))
            self.assertEqual(
                context.state["cli"]["windows_user_path_backup"],
                {"present": True, "value": r"C:\Tools", "kind": cli_install.REG_EXPAND_SZ},
            )

    def test_windows_is_idempotent_and_recognizes_equivalent_path(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            bin_dir = context.data_dir / "bin"
            registry = FakeRegistry(
                f'C:\\Tools;"{str(bin_dir).upper()}\\"', cli_install.REG_SZ
            )

            first = cli_install.install_cli(
                context, launcher, node, os_name="nt", home=root, registry=registry
            )
            second = cli_install.install_cli(
                context, launcher, node, os_name="nt", home=root, registry=registry
            )

            self.assertTrue(first["changed"])
            self.assertFalse(first["path_changed"])
            self.assertFalse(second["changed"])
            self.assertFalse(second["path_changed"])
            self.assertEqual(registry.writes, [])
            self.assertEqual(registry.broadcasts, 0)

    @unittest.skipUnless(os.name == "nt", "需要真实 Windows cmd.exe")
    def test_windows_cp936_executes_unicode_paths_and_preserves_exit_code(self) -> None:
        node_raw = shutil.which("node")
        if not node_raw:
            self.skipTest("未安装 Node.js")
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir) / "中文 根目录"
            root.mkdir()
            context = FakeContext(root / "Dbg 数据")
            launcher = root / "插件 目录" / "launch.cjs"
            launcher.parent.mkdir()
            launcher.write_text(
                'process.stdout.write("OK:" + process.argv[2]); process.exit(23);',
                encoding="utf-8",
            )
            registry = FakeRegistry(str(context.data_dir / "bin"), cli_install.REG_SZ)
            result = cli_install.install_cli(
                context,
                launcher,
                Path(node_raw),
                os_name="nt",
                home=root,
                registry=registry,
            )
            harness = root / "harness.cmd"
            harness.write_text(
                "@echo off\n"
                "chcp 936 >nul\n"
                "call \"%DBG_WRAPPER%\" doctor\n"
                "exit /b %errorlevel%\n",
                encoding="ascii",
            )
            environment = os.environ.copy()
            environment["DBG_WRAPPER"] = result["target"]

            completed = subprocess.run(
                ["cmd.exe", "/d", "/c", str(harness)],
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=30,
            )

            self.assertEqual(completed.returncode, 23, completed.stdout.decode("utf-8", "replace"))
            self.assertEqual(completed.stdout, b"OK:doctor")

            restore_harness = root / "restore.cmd"
            restore_harness.write_text(
                "@echo off\n"
                "chcp 936 >nul\n"
                "call \"%DBG_WRAPPER%\" doctor >nul\n"
                "chcp\n",
                encoding="ascii",
            )
            restored = subprocess.run(
                ["cmd.exe", "/d", "/c", str(restore_harness)],
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=30,
                check=True,
            )
            self.assertIn("936", restored.stdout.decode("cp936", "replace"))

    def test_windows_handles_percent_and_delayed_expansion_in_script_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            registry = FakeRegistry("", cli_install.REG_SZ)
            for unsafe in (root / "%TEMP%" / "node.exe", root / "!name!" / "node.exe"):
                unsafe.parent.mkdir(parents=True, exist_ok=True)
                unsafe.write_bytes(b"node")
                with self.subTest(path=unsafe):
                    result = cli_install.install_cli(
                        context, launcher, unsafe, os_name="nt", home=root, registry=registry
                    )
                    powershell = Path(result["target"]).with_name("dbg-cli.ps1")
                    self.assertIn(str(unsafe.resolve()), powershell.read_text("utf-8-sig"))

    def test_windows_recognizes_expanded_environment_path(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            local_app_data = context.data_dir.parent
            registry = FakeRegistry(r"C:\Tools;%LOCALAPPDATA%\data\bin", cli_install.REG_EXPAND_SZ)

            result = cli_install.install_cli(
                context,
                launcher,
                node,
                os_name="nt",
                home=root,
                environ={"LOCALAPPDATA": str(local_app_data)},
                registry=registry,
            )

            self.assertFalse(result["path_changed"])
            self.assertEqual(registry.writes, [])

    def test_windows_reports_broadcast_failure_without_rewriting_path(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            registry = FakeRegistry("", cli_install.REG_SZ)
            registry.broadcast_environment_change = lambda: False

            result = cli_install.install_cli(
                context, launcher, node, os_name="nt", home=root, registry=registry
            )

            self.assertTrue(result["path_changed"])
            self.assertEqual(len(result["warnings"]), 1)

    def test_windows_rejects_non_string_path_registry_type(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            registry = FakeRegistry("C:\\Tools", 7)

            with self.assertRaises(dbg_core.DbgError):
                cli_install.install_cli(
                    context, launcher, node, os_name="nt", home=root, registry=registry
                )

    def test_refuses_existing_unmanaged_wrapper_and_keeps_it(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            target = context.data_dir / "bin" / "dbg.cmd"
            target.parent.mkdir(parents=True)
            target.write_text("user command", encoding="utf-8")
            registry = FakeRegistry("", cli_install.REG_SZ)

            with self.assertRaises(dbg_core.DbgError):
                cli_install.install_cli(
                    context, launcher, node, os_name="nt", home=root, registry=registry
                )

            self.assertEqual(target.read_text(encoding="utf-8"), "user command")
            self.assertEqual(registry.writes, [])

    def test_refuses_a_symlink_in_the_command_slot(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            home = context.data_dir.parent
            target = home / ".local" / "bin" / "dbg"
            linked = root / "user-command"
            linked.write_text("user command", encoding="utf-8")
            target.parent.mkdir(parents=True)
            simulated_symlink = False
            try:
                target.symlink_to(linked)
            except OSError:
                simulated_symlink = True

            def invoke() -> None:
                with self.assertRaises(dbg_core.DbgError):
                    cli_install.install_cli(
                        context,
                        launcher,
                        node,
                        os_name="posix",
                        home=home,
                        environ={"PATH": ""},
                    )

            if simulated_symlink:
                real_is_symlink = Path.is_symlink

                def is_command_symlink(path: Path) -> bool:
                    return path == target or real_is_symlink(path)

                with mock.patch.object(
                    Path, "is_symlink", autospec=True, side_effect=is_command_symlink
                ):
                    invoke()
            else:
                invoke()

            self.assertEqual(linked.read_text(encoding="utf-8"), "user command")

    def test_updates_only_a_previously_managed_wrapper(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            registry = FakeRegistry("", cli_install.REG_SZ)
            cli_install.install_cli(
                context, launcher, node, os_name="nt", home=root, registry=registry
            )
            replacement = root / "Node 2" / "node.exe"
            replacement.parent.mkdir()
            replacement.write_bytes(b"new node")

            result = cli_install.install_cli(
                context, launcher, replacement, os_name="nt", home=root, registry=registry
            )

            self.assertTrue(result["changed"])
            companion = Path(result["target"]).with_name("dbg-cli.ps1")
            self.assertIn(str(replacement.resolve()), companion.read_text("utf-8-sig"))

    def test_unix_installs_executable_wrapper_and_returns_path_hint(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            result = cli_install.install_cli(
                context,
                launcher,
                node,
                os_name="posix",
                home=root / "home with quote's",
                environ={"PATH": "/usr/bin:/bin"},
            )

            target = root / "home with quote's" / ".local/bin/dbg"
            self.assertEqual(Path(result["target"]), target)
            if os.name != "nt":
                self.assertTrue(os.stat(target).st_mode & stat.S_IXUSR)
            expected_node = cli_install.shell_quote(str(node.resolve()))
            expected_launcher = cli_install.shell_quote(str(launcher.resolve()))
            self.assertEqual(
                target.read_text(encoding="utf-8"),
                f"#!/bin/sh\nexec {expected_node} {expected_launcher} \"$@\"\n",
            )
            self.assertIn("export PATH=", result["path_hint"])
            self.assertIn(cli_install.shell_quote(str(target.parent)), result["path_hint"])

    def test_unix_has_no_hint_when_bin_is_already_on_path(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            home = root / "home"
            bin_dir = home / ".local/bin"

            with mock.patch.object(
                cli_install, "_path_contains_posix", return_value=True
            ):
                result = cli_install.install_cli(
                    context,
                    launcher,
                    node,
                    os_name="posix",
                    home=home,
                    environ={"PATH": f"/usr/bin:{bin_dir}"},
                )

            self.assertIsNone(result["path_hint"])

    def test_posix_path_matching_uses_complete_entries(self) -> None:
        directory = Path("/home/debugger/.local/bin")
        self.assertTrue(
            cli_install._path_contains_posix(
                "/usr/bin:/home/debugger/.local/bin:/bin", directory
            )
        )
        self.assertFalse(
            cli_install._path_contains_posix(
                "/usr/bin:/home/debugger/.local/bin-old:/bin", directory
            )
        )

    def test_requires_absolute_existing_node_and_launcher(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            context, launcher, node = self._inputs(root)
            with self.assertRaises(dbg_core.DbgError):
                cli_install.install_cli(
                    context, Path("launch.cjs"), node, os_name="posix", home=root
                )
            node.unlink()
            with self.assertRaises(dbg_core.DbgError):
                cli_install.install_cli(
                    context, launcher, node, os_name="posix", home=root
                )


if __name__ == "__main__":
    unittest.main()
