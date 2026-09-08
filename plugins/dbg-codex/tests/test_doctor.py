import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dbg_core import DbgError, atomic_json, load_json
from discovery import Installation
from doctor import run_doctor


class FakeContext:
    def __init__(self, data_dir, state, backup_dir):
        self.data_dir, self.state, self.backup_dir = data_dir, state, backup_dir
        self.warnings = []

    def save(self):
        atomic_json(self.data_dir / "state.json", self.state)


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.installs = [Installation("ida", self.root / "ida", "9.0")]
        self.calls = []

    def install(self, installations, ctx):
        self.calls.append(installations)
        return {"version": "1.2", "runtime": {"command": [sys.executable], "env": {"TOKEN": "not-in-summary"}}}

    def run_case(self, **kwargs):
        return run_doctor(self.root, recipe_map={"ida-mcp": ("ida", self.install)},
                          discover_fn=lambda paths: self.installs,
                          context_type=FakeContext, **kwargs)

    def test_first_auto_and_explicit_doctor_use_same_install_workflow(self):
        self.assertEqual(self.run_case(auto=True)["status"], "complete")
        self.assertEqual(self.run_case(auto=True)["status"], "unchanged")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.run_case()["status"], "complete")
        self.assertEqual(len(self.calls), 2)

    def test_new_tool_is_discovered_by_explicit_doctor_after_initial_skip(self):
        self.installs = []
        result = self.run_case(auto=True)
        self.assertEqual(result["tools"]["ida-mcp"]["status"], "not_installed")
        self.installs = [Installation("ida", self.root / "later")]
        self.run_case()
        self.assertEqual(len(self.calls), 1)

    def test_failures_keep_previous_runtime_and_continue_other_tools(self):
        self.run_case()
        def fail(installs, ctx):
            raise DbgError("download unavailable")
        calls = []
        def second(installs, ctx):
            calls.append(True)
            return {"version": "1"}
        result = run_doctor(self.root, recipe_map={"ida-mcp": ("ida", fail), "ida-export": ("ida", second)},
                            discover_fn=lambda paths: self.installs, context_type=FakeContext)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(calls, [True])
        record = load_json(self.root / "state.json")["tools"]["ida-mcp"]
        self.assertEqual(record["runtime"]["command"], [sys.executable])
        self.assertEqual(record["last_error"], "download unavailable")

    def test_failure_is_not_retried_by_each_automatic_mcp_startup(self):
        attempts = []
        def fail(installs, ctx):
            attempts.append(True)
            raise DbgError("offline")
        for _ in range(4):
            run_doctor(self.root, auto=True, recipe_map={"ida-mcp": ("ida", fail)},
                       discover_fn=lambda paths: self.installs, context_type=FakeContext)
        self.assertEqual(len(attempts), 1)
        run_doctor(self.root, recipe_map={"ida-mcp": ("ida", fail)},
                   discover_fn=lambda paths: self.installs, context_type=FakeContext)
        self.assertEqual(len(attempts), 2)

    def test_report_does_not_include_runtime_secrets(self):
        result = self.run_case()
        self.assertNotIn("not-in-summary", json.dumps(result))
        self.assertNotIn("not-in-summary", (self.root / "last-report.json").read_text())

    def test_unsupported_version_is_explicit_and_has_no_runtime(self):
        self.run_case()
        def unsupported(installs, ctx):
            return {"status": "unsupported", "message": "requires IDA 8.3"}
        result = run_doctor(self.root, recipe_map={"ida-mcp": ("ida", unsupported)},
                            discover_fn=lambda paths: self.installs, context_type=FakeContext)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["tools"]["ida-mcp"]["status"], "unsupported")
        self.assertNotIn("runtime", load_json(self.root / "state.json")["tools"]["ida-mcp"])

    def test_corrupt_state_is_not_overwritten(self):
        p = self.root / "state.json"
        p.write_text('{"broken":', encoding="utf-8")
        with self.assertRaises(DbgError):
            self.run_case()
        self.assertEqual(p.read_text(), '{"broken":')


if __name__ == "__main__":
    unittest.main()
