import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from managed_server import select_http_runtime


class ManagedServerTests(unittest.TestCase):
    def test_node_pipe_reaches_registered_runtime_and_preserves_output(self):
        # 复现真实 Node -> Python 路由 -> 隔离后端的标准流转交，覆盖 Windows CRT 管道。
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
            self.assertEqual(replies[1]["result"]["tools"][0]["name"], "dbg_windbg_status")
            self.assertIn("doctor", replies[2]["result"]["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
