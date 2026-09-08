import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dbg_core import DbgError
from ghidra_adapter import user_settings_dir
from ghidra_adapter import javac_path, system_java_candidates
from discovery import Installation


class GhidraPathsTests(unittest.TestCase):
    def test_xdg_precedes_platform_default(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {"XDG_CONFIG_HOME": d}), patch("ghidra_adapter.Path.home", return_value=Path(d)):
            for platform in ("win32", "darwin", "linux"):
                with patch("ghidra_adapter.sys.platform", platform):
                    self.assertEqual(user_settings_dir("12.1.3"), Path(d) / "ghidra/ghidra_12.1.3_PUBLIC")

    def test_explicit_ghidra_settings_directory_precedes_xdg(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "support").mkdir()
            custom = root / "custom"
            (root / "support/launch.properties").write_text(
                f"#VMARGS=-Dapplication.settingsdir=ignored\nVMARGS=-Dapplication.settingsdir={custom}\n", encoding="utf-8")
            with patch("ghidra_adapter.Path.home", return_value=root):
                self.assertEqual(user_settings_dir("12.1.3", root), custom / "ghidra/ghidra_12.1.3_PUBLIC")

    def test_custom_directory_outside_home_uses_user_prefix(self):
        with tempfile.TemporaryDirectory() as d, patch("ghidra_adapter.Path.home", return_value=Path(d) / "home"), patch("ghidra_adapter.getpass.getuser", return_value="tester"):
            with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(Path(d) / "shared")}):
                self.assertEqual(user_settings_dir("12.1.3"), Path(d) / "shared/tester-ghidra/ghidra_12.1.3_PUBLIC")

    def test_unknown_version_is_not_guessed(self):
        with self.assertRaises(DbgError):
            user_settings_dir("")

    def test_brew_jdk_outside_path_is_probed_and_old_jdk_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve()
            host = root / "ghidra"
            host.mkdir()
            old = root / "java17/bin/javac"
            current = root / "brew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/javac"
            if os.name == "nt":
                old, current = old.with_suffix(".exe"), current.with_suffix(".exe")
            for path in (old, current):
                path.parent.mkdir(parents=True)
                path.touch()
            with patch.dict(os.environ, {}, clear=True), patch("ghidra_adapter.shutil.which", return_value=str(old)), patch("ghidra_adapter.system_java_candidates", return_value=iter([current])), patch("ghidra_adapter.user_settings_dir", return_value=root / "settings"), patch("ghidra_adapter.run_command", side_effect=lambda args, **kw: "javac 17.0.1" if args[0] == old else "javac 21.0.9"):
                self.assertEqual(javac_path(Installation("ghidra", host, "12.1.3")), current)

    def test_brew_active_jdk_layout_is_available_on_macos_and_linux(self):
        with tempfile.TemporaryDirectory() as d:
            prefix = Path(d).resolve()
            (prefix / "opt/openjdk@21").mkdir(parents=True)
            (prefix / "opt/openjdk-unrelated").mkdir()
            for platform in ("darwin", "linux"):
                with patch("ghidra_adapter.sys.platform", platform), patch("homebrew.homebrew_prefixes", return_value=[prefix]):
                    candidates = list(system_java_candidates())
                    self.assertIn(prefix / "opt/openjdk@21/bin/javac", candidates)
                    self.assertIn(prefix / "opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/javac", candidates)
                    self.assertFalse(any("openjdk-unrelated" in str(x) for x in candidates))
