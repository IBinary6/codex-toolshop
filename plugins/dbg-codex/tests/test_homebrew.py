from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import homebrew  # noqa: E402


class HomebrewPrefixTests(unittest.TestCase):
    def test_environment_prefix_is_evidence_when_directory_exists(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            prefix = root / "brew-prefix"
            prefix.mkdir()
            with (
                mock.patch.dict(os.environ, {"HOMEBREW_PREFIX": str(prefix)}, clear=True),
                mock.patch.object(homebrew.shutil, "which", return_value=None),
                mock.patch.object(Path, "home", return_value=root / "home"),
                mock.patch.object(homebrew, "_default_prefixes", return_value=[]),
            ):
                self.assertEqual(homebrew.homebrew_prefixes(), [prefix.resolve()])

    def test_path_brew_prefix_command_is_bounded_and_disables_background_behavior(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            brew = root / "bin" / "brew"
            brew.parent.mkdir()
            brew.touch()
            prefix = root / "resolved-prefix"
            prefix.mkdir()
            completed = subprocess.CompletedProcess(
                [str(brew), "--prefix"], 0, stdout=f"{prefix}\n", stderr=""
            )
            with (
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch.object(homebrew.shutil, "which", return_value=str(brew)),
                mock.patch.object(homebrew.subprocess, "run", return_value=completed) as run,
                mock.patch.object(homebrew, "_default_prefixes", return_value=[]),
            ):
                self.assertEqual(homebrew.homebrew_prefixes(), [prefix.resolve()])

            _, kwargs = run.call_args
            self.assertFalse(kwargs["shell"])
            self.assertGreater(kwargs["timeout"], 0)
            self.assertEqual(kwargs["env"]["HOMEBREW_NO_AUTO_UPDATE"], "1")
            self.assertEqual(kwargs["env"]["HOMEBREW_NO_ANALYTICS"], "1")

    def test_brew_failure_falls_back_without_raising(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            brew = root / "brew"
            brew.touch()
            fallback = root / "fallback"
            (fallback / "bin").mkdir(parents=True)
            (fallback / "bin" / "brew").touch()
            with (
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch.object(homebrew.shutil, "which", return_value=str(brew)),
                mock.patch.object(
                    homebrew.subprocess,
                    "run",
                    side_effect=subprocess.TimeoutExpired([str(brew), "--prefix"], 1),
                ),
                mock.patch.object(homebrew, "_default_prefixes", return_value=[fallback]),
            ):
                self.assertEqual(homebrew.homebrew_prefixes(), [fallback.resolve()])


class HomebrewCaskTests(unittest.TestCase):
    def test_queries_only_installed_ghidra_and_ida_family_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            prefix = root / "brew"
            brew = prefix / "bin" / "brew"
            brew.parent.mkdir(parents=True)
            brew.touch()
            second_prefix = root / "rosetta-brew"
            second_brew = second_prefix / "bin" / "brew"
            second_brew.parent.mkdir(parents=True)
            second_brew.touch()
            custom_appdir = root / "Custom Apps"
            ghidra_app = custom_appdir / "Ghidra.app"
            ida_app = custom_appdir / "IDA Professional.app"
            ghidra_file = ghidra_app / "Contents" / "Info.plist"
            ida_file = ida_app / "Contents" / "MacOS" / "ida"
            ghidra_file.parent.mkdir(parents=True)
            ida_file.parent.mkdir(parents=True)
            ghidra_file.touch()
            ida_file.touch()

            def command_result(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
                args = command[1:]
                if args == ["list", "--cask", "-1"]:
                    output = (
                        "ghidra\nfirefox\n"
                        if Path(command[0]).resolve() == brew.resolve()
                        else "ida-pro\n"
                    )
                elif args == ["list", "--cask", "ghidra"]:
                    output = f"{ghidra_file}\n"
                elif args == ["list", "--cask", "ida-pro"]:
                    output = f"{ida_file}\n"
                else:
                    self.fail(f"不应查询命令: {command}")
                return subprocess.CompletedProcess(command, 0, stdout=output, stderr="")

            with (
                mock.patch.object(homebrew.shutil, "which", return_value=None),
                mock.patch.object(homebrew.subprocess, "run", side_effect=command_result),
            ):
                artifacts = homebrew.homebrew_cask_artifacts([prefix, second_prefix])

            self.assertEqual(artifacts["ghidra"], [ghidra_app.resolve()])
            self.assertEqual(artifacts["ida"], [ida_app.resolve()])

    def test_resolves_caskroom_app_symlink_to_custom_appdir(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            prefix = root / "brew"
            brew = prefix / "bin" / "brew"
            brew.parent.mkdir(parents=True)
            brew.touch()
            custom_app = root / "Custom Apps" / "IDA.app"
            custom_app.mkdir(parents=True)
            link = prefix / "Caskroom" / "ida-pro" / "9.3" / "IDA.app"
            link.parent.mkdir(parents=True)
            try:
                link.symlink_to(custom_app, target_is_directory=True)
            except OSError as exc:
                if os.name == "nt" and getattr(exc, "winerror", None) == 1314:
                    self.skipTest(f"当前 Windows 用户没有创建目录符号链接的权限: {exc}")
                raise

            def command_result(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
                args = command[1:]
                output = "ida-pro\n" if args == ["list", "--cask", "-1"] else f"{link}\n"
                return subprocess.CompletedProcess(command, 0, stdout=output, stderr="")

            with (
                mock.patch.object(homebrew.shutil, "which", return_value=None),
                mock.patch.object(homebrew.subprocess, "run", side_effect=command_result),
            ):
                artifacts = homebrew.homebrew_cask_artifacts([prefix])

            self.assertEqual(artifacts["ida"], [custom_app.resolve()])


if __name__ == "__main__":
    unittest.main()
