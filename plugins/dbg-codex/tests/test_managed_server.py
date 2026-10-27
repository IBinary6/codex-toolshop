import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from managed_server import select_http_runtime, run_windbg
from windbg import legacy_available


class ManagedServerTests(unittest.TestCase):
    def test_native_creation_failure_only_falls_back_in_auto_and_preserves_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proxy = root / "DbgX.Mcp.Proxy.exe"
            proxy.touch()
            engine = root / "cdb.exe"
            engine.touch()
            native = {"command": [str(proxy)], "env": {}}
            backup = {"command": [sys.executable, "-m", "mcp_windbg"], "env": {"CDB_PATH": str(engine), "_NT_SYMBOL_PATH": "kept"}}
            record = {"backend": "native", "runtime": native, "legacy_runtime": backup}
            with mock.patch("managed_server.start_native", side_effect=PermissionError()) as start, \
                 mock.patch("managed_server.run_stdio", return_value=0) as run, \
                 mock.patch("sys.stderr") as stderr:
                self.assertEqual(run_windbg(record, "auto"), 0)
                start.assert_called_once_with(native)
                run.assert_called_once_with(backup)
                self.assertIn("legacy", "".join(call.args[0] for call in stderr.write.call_args_list))
            with mock.patch("managed_server.start_native", side_effect=PermissionError()) as run, mock.patch("sys.stderr"):
                self.assertEqual(run_windbg(record, "native"), 1)
                self.assertEqual(run.call_count, 1)
            with mock.patch("managed_server.start_native", return_value=mock.Mock(wait=mock.Mock(return_value=7))) as run, \
                 mock.patch("managed_server.run_stdio") as fallback:
                self.assertEqual(run_windbg(record, "auto"), 7)
                self.assertEqual(run.call_count, 1)
                fallback.assert_not_called()
            with mock.patch("managed_server.start_native", return_value=mock.Mock(wait=mock.Mock(side_effect=OSError()))), \
                 mock.patch("managed_server.run_stdio") as fallback:
                with self.assertRaises(OSError):
                    run_windbg(record, "auto")
                fallback.assert_not_called()
            engine.unlink()
            self.assertFalse(legacy_available(backup))
            with mock.patch("managed_server.start_native", side_effect=FileNotFoundError()) as run, mock.patch("sys.stderr"):
                self.assertEqual(run_windbg(record, "auto"), 1)
                self.assertEqual(run.call_count, 1)

    def test_missing_native_executable_uses_backup_without_attempting_native(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = Path(directory) / "kd.exe"
            engine.touch()
            backup = {"command": [sys.executable, "-m", "mcp_windbg"], "env": {"KD_PATH": str(engine)}}
            record = {"backend": "native", "runtime": {"command": [str(Path(directory) / "missing.exe")]}, "legacy_runtime": backup}
            with mock.patch("managed_server.run_stdio", return_value=0) as run, mock.patch("sys.stderr"):
                self.assertEqual(run_windbg(record, "auto"), 0)
                run.assert_called_once_with(backup)

    def test_node_pipe_reaches_registered_runtime_and_preserves_output(self):
        # Reproduce the real Node -> Python router -> isolated backend stdio flow, including Windows CRT pipes.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = root / "backend.py"
            backend.write_text("import sys\nfor line in sys.stdin:\n print('reply:' + line.strip(), flush=True)\n", encoding="utf-8")
            (root / "state.json").write_text(json.dumps({"tools": {"ghidra": {"runtime": {
                "command": [sys.executable, str(backend)], "env": {}}}}}), encoding="utf-8")
            script = Path(__file__).resolve().parents[1] / "scripts/managed_server.py"
            relay = "const c=require('node:child_process').spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit',windowsHide:true});c.on('exit',code=>process.exitCode=code);"
            result = subprocess.run(["node", "-e", relay, sys.executable, str(script), "ghidra"],
                input="initialize\ntools/list\n", capture_output=True, text=True, encoding="utf-8", timeout=10,
                env={**os.environ, "DBG_HOME": directory, "PYTHONUTF8": "1"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), ["reply:initialize", "reply:tools/list"])

    def test_native_stdio_and_runtime_disabled_config_with_stale_deployed_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = root / "native_stub.py"
            backend.write_text("import sys\nfor line in sys.stdin:\n print('native:' + line.strip(), flush=True)\n", encoding="utf-8")
            (root / "state.json").write_text(json.dumps({"tools": {"windbg": {
                "status": "deployed", "backend": "native", "runtime": {"command": [sys.executable, str(backend)], "env": {}}}}}), encoding="utf-8")
            script = Path(__file__).resolve().parents[1] / "scripts/managed_server.py"
            def run(request):
                return subprocess.run([sys.executable, str(script), "windbg"], input=request,
                    capture_output=True, text=True, encoding="utf-8", timeout=10,
                    env={**os.environ, "DBG_HOME": directory, "PYTHONUTF8": "1"})
            result = run("initialize\ntools/list\n")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), ["native:initialize", "native:tools/list"])
            (root / "config.json").write_text('{"disabled":["windbg"]}', encoding="utf-8")
            result = run(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "dbg_windbg_status"}}) + "\n")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("disabled", json.loads(result.stdout)["result"]["content"][0]["text"])

    def test_x32_uses_its_own_endpoint_even_when_x64_is_present(self):
        state = {"tools": {"x64dbg": {"runtime": {"url": "http://127.0.0.1:9094/"},
                   "instances": [{"architecture": "x32", "runtime": {"url": "http://127.0.0.1:9095/"}}]}}}
        self.assertEqual(select_http_runtime(state, "x32dbg")["url"], "http://127.0.0.1:9095/")
        self.assertEqual(select_http_runtime(state, "x64dbg")["url"], "http://127.0.0.1:9094/")
        state["tools"]["x64dbg"]["instances"] = []
        self.assertEqual(select_http_runtime(state, "x32dbg"), {})

    def test_missing_optional_tool_has_a_valid_mcp_status_endpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            requests = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "dbg_windbg_status", "arguments": {}}},
            ]
            script = Path(__file__).resolve().parents[1] / "scripts/managed_server.py"
            result = subprocess.run([sys.executable, str(script), "windbg"],
                                    input="\n".join(json.dumps(x) for x in requests) + "\n",
                                    capture_output=True, text=True, encoding="utf-8", timeout=10,
                                    env={**os.environ, "DBG_HOME": directory, "PYTHONUTF8": "1"})
            self.assertEqual(result.returncode, 0, result.stderr)
            replies = [json.loads(x) for x in result.stdout.splitlines()]
            self.assertEqual([x["id"] for x in replies], [1, 2, 3])
            manifest = Path(__file__).resolve().parents[1] / ".codex-plugin/plugin.json"
            version = json.loads(manifest.read_text(encoding="utf-8"))["version"]
            self.assertEqual(replies[0]["result"]["serverInfo"]["version"], version)
            self.assertEqual(replies[1]["result"]["tools"][0]["name"], "dbg_windbg_status")
            self.assertIn("doctor", replies[2]["result"]["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
