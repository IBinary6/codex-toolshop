from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import discovery  # noqa: E402


class DetectAtTests(unittest.TestCase):
    def test_resolves_scoop_ghidra_shim_to_real_installation(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            install = root / "apps" / "ghidra" / "12.1.3"
            (install / "Ghidra").mkdir(parents=True)
            launcher = install / "ghidraRun.bat"
            launcher.touch()
            (install / "Ghidra" / "application.properties").write_text(
                "application.version=12.1.3", encoding="utf-8"
            )
            shims = root / "shims"
            shims.mkdir()
            shim_launcher = shims / "ghidraRun.bat"
            shim_launcher.touch()
            (shims / "ghidraRun.shim").write_text(
                '{"path": ' + json.dumps(str(launcher)) + '}', encoding="utf-8"
            )

            found = discovery.detect_at("ghidra", shim_launcher, "path")

            self.assertIsNotNone(found)
            self.assertEqual(found.root, install.resolve())
            self.assertEqual(found.version, "12.1.3")

    def test_rejects_ghidra_launcher_without_core_properties(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            (root / "ghidraRun.bat").touch()
            self.assertIsNone(discovery.detect_at("ghidra", root, "path"))

    def test_windbg_requires_cdb_or_kd_engine(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            (root / "WinDbg.exe").touch()
            self.assertIsNone(discovery.detect_at("windbg", root, "appx"))

    def test_normalizes_x64dbg_release_root(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            release = root / "x64dbg" / "current" / "release"
            executable = release / "x64" / "x64dbg.exe"
            executable.parent.mkdir(parents=True)
            executable.touch()

            found = discovery.detect_at("x64dbg", root / "x64dbg" / "current", "override")
            self.assertEqual(
                found,
                discovery.Installation(
                    "x64dbg", release.resolve(), architecture="x64", source="override"
                ),
            )

    def test_reads_ghidra_application_version(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir) / "ghidra"
            (root / "Ghidra").mkdir(parents=True)
            (root / "ghidraRun.bat").touch()
            (root / "Ghidra" / "application.properties").write_text(
                "application.name=Ghidra\napplication.version=12.1.3\n", encoding="utf-8"
            )

            found = discovery.detect_at("ghidra", root, "scoop")
            self.assertIsNotNone(found)
            self.assertEqual(found.version, "12.1.3")

    def test_detects_ida_macos_app_contents(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            app = Path(raw_dir) / "IDA Professional.app"
            binary = app / "Contents" / "MacOS" / "ida64"
            binary.parent.mkdir(parents=True)
            binary.touch()

            found = discovery.detect_at("ida", app, "override")
            self.assertEqual(found.root, app.resolve())


class DiscoverTests(unittest.TestCase):
    def test_scoop_current_excludes_inactive_old_versions(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            scoop = Path(raw_dir) / "scoop"
            app = scoop / "apps" / "ghidra"
            current = app / "current"
            old = app / "12.0.3"
            current.mkdir(parents=True)
            old.mkdir()

            self.assertEqual(
                discovery._scoop_app_candidates(scoop, ("ghidra",)),
                [current],
            )

    def test_rejects_malformed_overrides(self) -> None:
        invalid_values = (
            "not-an-object",
            {"x64dbg": "C:/tool"},
            {"x64dbg": ["C:/tool", 123]},
            {"unknown": ["C:/tool"]},
        )
        for value in invalid_values:
            with self.subTest(value=value), self.assertRaises(discovery.DbgError):
                discovery.discover(value)  # type: ignore[arg-type]

    def test_all_overrides_precede_automatic_results(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            x64dbg = root / "x64dbg" / "release"
            (x64dbg / "x64").mkdir(parents=True)
            (x64dbg / "x64" / "x64dbg.exe").touch()
            ghidra = root / "ghidra"
            (ghidra / "Ghidra").mkdir(parents=True)
            (ghidra / "ghidraRun.bat").touch()
            (ghidra / "Ghidra" / "application.properties").write_text(
                "application.version=12.1.3", encoding="utf-8"
            )
            automatic = {tool: [] for tool in discovery.TOOLS}
            automatic["x64dbg"] = [x64dbg]

            with mock.patch.object(discovery, "_automatic_candidates", return_value=automatic):
                found = discovery.discover({"ghidra": [str(ghidra)]})

            self.assertEqual([item.tool for item in found], ["ghidra", "x64dbg"])

    def test_overrides_are_first_and_duplicate_roots_are_removed(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            first = root / "first" / "release"
            second = root / "second" / "release"
            for release in (first, second):
                executable = release / "x64" / "x64dbg.exe"
                executable.parent.mkdir(parents=True)
                executable.touch()

            with mock.patch.object(discovery, "_automatic_candidates", return_value={"x64dbg": [first]}):
                found = discovery.discover({"x64dbg": [str(first), str(first), str(second)]})

            self.assertEqual([item.root for item in found], [first.resolve(), second.resolve()])
            self.assertTrue(all(item.source == "override" for item in found))

    def test_scoop_candidates_include_configured_roots_and_real_versions(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            scoop = root / "scoop"
            version = scoop / "apps" / "ghidra" / "12.1.3"
            (version / "Ghidra").mkdir(parents=True)
            (version / "ghidraRun.bat").touch()
            (version / "Ghidra" / "application.properties").write_text(
                "application.version=12.1.3", encoding="utf-8"
            )
            env = {"SCOOP": str(scoop), "PROGRAMDATA": str(root / "programdata")}

            with (
                mock.patch.dict(os.environ, env, clear=True),
                mock.patch.object(discovery.platform, "system", return_value="Windows"),
                mock.patch.object(discovery, "_windows_registry_candidates", return_value={}),
                mock.patch.object(discovery.shutil, "which", return_value=None),
                mock.patch.object(Path, "home", return_value=root / "home"),
            ):
                found = discovery.discover()

            ghidra = [item for item in found if item.tool == "ghidra"]
            self.assertEqual([(item.root, item.version) for item in ghidra], [(version.resolve(), "12.1.3")])


if __name__ == "__main__":
    unittest.main()
