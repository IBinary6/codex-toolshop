import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dbg_core import DbgError
from ghidra_adapter import user_settings_dir


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
