"""Verify session configuration with real official Serena/PyYAML from the private venv."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

HELPER = Path(__file__).resolve().parents[3] / "scripts" / "serena-session.py"


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="serena-session-test-")
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "stable-home"
        self.home = self.root / "session-home"
        self.project = self.root / "Project"
        self.source.mkdir()
        (self.source / "modes").mkdir()
        (self.source / "modes" / "custom.yml").write_text("description: preserved\n", encoding="utf-8")
        (self.project / ".serena").mkdir(parents=True)
        self.project_file = self.project / ".serena" / "project.yml"
        self.project_file.write_text("project_name: ExactName\nlanguage_servers: [cpp]\n", encoding="utf-8")
        self.project_bytes = self.project_file.read_bytes()
        self.base = {"projects": [str(self.project)], "trusted_projects": [], "base_modes": ["custom"],
                     "ls_specific_settings": {"python": {"custom_setting": "preserve"}}}
        self.write_base()

    def tearDown(self):
        self.temporary.cleanup()

    def write_base(self):
        (self.source / "serena_config.yml").write_text(yaml.safe_dump(self.base), encoding="utf-8")

    def command(self, command, **arguments):
        result = subprocess.run([sys.executable, "-I", "-B", str(HELPER)],
            input=json.dumps({"command": command, "home": str(self.home), **arguments}),
            text=True, encoding="utf-8", capture_output=True,
            env={**os.environ, "SERENA_HOME": str(self.home)}, timeout=30)
        self.assertEqual(result.returncode, 0)
        return json.loads(result.stdout)

    def clone(self):
        self.assertTrue(self.command("clone", source=str(self.source))["ok"])

    def data(self):
        return yaml.safe_load((self.home / "serena_config.yml").read_text(encoding="utf-8"))

    def test_clone_resolve_does_not_save_project(self):
        self.clone()
        self.assertEqual(self.data(), self.base)
        self.assertTrue((self.home / "modes" / "custom.yml").is_file())
        resolved = self.command("resolve", project="ExactName")
        self.assertEqual(Path(resolved["root"]), self.project)
        self.assertEqual(resolved["name"], "ExactName")
        unknown = self.command("resolve", project="relative/unregistered")
        self.assertIsNone(unknown["root"])
        self.assertEqual(self.project_file.read_bytes(), self.project_bytes)

    def test_generation_and_fallback(self):
        self.clone()
        database = self.root / "immutable-db"
        database.mkdir()
        canonical = database / "compile_commands.json"
        canonical.write_text("[]", encoding="utf-8")
        ready = {"status": "ready", "generation": "one", "databaseDir": str(database)}
        result = self.command("apply", root=str(self.project), preparation=ready)
        self.assertTrue(result["ok"])
        cpp = self.data()["ls_specific_settings"]["cpp"]
        self.assertEqual(cpp["ls_extra_args"], ["-j=2", f"--compile-commands-dir={database}"])
        self.assertTrue(Path(cpp["compile_commands_dir"]).is_relative_to(self.home / "compile-cache"))
        self.assertFalse((database / "serena-cache-transformed").exists())
        self.assertEqual(canonical.read_text(), "[]")
        self.assertEqual(self.data()["ls_specific_settings"]["python"], self.base["ls_specific_settings"]["python"])
        native = self.command("apply", root=str(self.project), preparation={**ready, "nativeRootDatabase": True})
        self.assertTrue(native["ok"])
        native_cpp = self.data()["ls_specific_settings"]["cpp"]
        self.assertEqual(native_cpp["ls_extra_args"], ["-j=2"])
        self.assertNotEqual(native_cpp["compile_commands_dir"], cpp["compile_commands_dir"])
        self.command("apply", root=str(self.project), preparation={"status": "failed", "generation": "fallback"})
        self.assertNotIn("cpp", self.data()["ls_specific_settings"])
        self.assertEqual(self.project_file.read_bytes(), self.project_bytes)

    def test_explicit_user_configuration(self):
        self.base["ls_specific_settings"]["cpp"] = {"ls_extra_args": ["--compile-commands-dir=C:/user-db"], "clangd_version": "21"}
        self.write_base(); self.clone()
        result = self.command("apply", root=str(self.project), preparation={"status": "ready", "databaseDir": str(self.root / "db")})
        self.assertTrue(result["diagnostics"])
        self.assertEqual(self.data()["ls_specific_settings"], self.base["ls_specific_settings"])
        self.assertEqual(self.project_file.read_bytes(), self.project_bytes)

    def test_user_jobs_and_other_args_are_preserved(self):
        database = self.root / "db"
        database.mkdir()
        ready = {"status": "ready", "generation": "one", "databaseDir": str(database)}
        self.base["ls_specific_settings"]["cpp"] = {"ls_extra_args": ["--pch-storage=memory"]}
        self.write_base(); self.clone()
        self.command("apply", root=str(self.project), preparation=ready)
        initial_cpp = self.data()["ls_specific_settings"]["cpp"]
        self.assertEqual(initial_cpp["ls_extra_args"], ["--pch-storage=memory", "-j=2", f"--compile-commands-dir={database}"])
        for jobs in (["-j=8"], ["-j", "6"], ["-j4"]):
            with self.subTest(jobs=jobs):
                args = ["--pch-storage=memory", *jobs]
                # Simulate the next session loading user overrides from stable configuration with the same root and database generation.
                base = {**self.base, "ls_specific_settings": {"cpp": {"ls_extra_args": args}}}
                (self.home / "frontend-base.yml").write_text(yaml.safe_dump(base), encoding="utf-8")
                self.command("apply", root=str(self.project), preparation=ready)
                cpp = self.data()["ls_specific_settings"]["cpp"]
                self.assertEqual(cpp["ls_extra_args"], [*args, f"--compile-commands-dir={database}"])
                self.assertNotEqual(cpp["compile_commands_dir"], initial_cpp["compile_commands_dir"])
                self.command("apply", root=str(self.project), preparation={**ready, "nativeRootDatabase": True})
                self.assertEqual(self.data()["ls_specific_settings"]["cpp"]["ls_extra_args"], args)
        self.assertEqual(self.project_file.read_bytes(), self.project_bytes)

    def test_custom_cpp_owns_concurrency(self):
        self.base["ls_specific_settings"]["cpp"] = {"ls_path": "custom-clangd", "ls_extra_args": ["--pch-storage=memory"]}
        self.write_base(); self.clone()
        result = self.command("apply", root=str(self.project), preparation={"status": "ready", "databaseDir": str(self.root / "db")})
        self.assertTrue(result["diagnostics"])
        self.assertEqual(self.data()["ls_specific_settings"], self.base["ls_specific_settings"])


if __name__ == "__main__":
    unittest.main()
