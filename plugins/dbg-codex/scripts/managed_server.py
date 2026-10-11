"""Start upstream MCP from Dbg state; missing tools report their real status instead of claiming debugging capability."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import subprocess

from dbg_core import default_data_dir, load_json
from plugin_version import current_version


def select_http_runtime(state, tool):
    record = state.get("tools", {}).get("x64dbg" if tool == "x32dbg" else tool, {})
    if tool == "x32dbg":
        instances = [x for x in record.get("instances", []) if x.get("architecture") == "x32"]
        return instances[0].get("runtime", {}) if instances else {}
    return record.get("runtime", {})


def status_server(tool: str, message: str):
    """A minimal stdio status service keeps an optional missing tool from failing the entire plugin load."""
    name = "dbg_" + tool.replace("-", "_") + "_status"
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if "id" not in request:
                continue
            method = request.get("method")
            if method == "initialize":
                result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "dbg-" + tool, "version": current_version()}}
            elif method == "tools/list":
                result = {"tools": [{"name": name, "description": "Show this debugger tool deployment status", "inputSchema": {"type": "object", "properties": {}}}]}
            elif method == "tools/call" and request.get("params", {}).get("name") == name:
                result = {"content": [{"type": "text", "text": message}]}
            elif method == "ping":
                result = {}
            else:
                print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Method not available"}}), flush=True)
                continue
            print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}, ensure_ascii=False), flush=True)
        except (ValueError, TypeError):
            print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}), flush=True)


def main():
    tool = sys.argv[1]
    state = load_json(default_data_dir() / "state.json", default={})
    record = state.get("tools", {}).get("x64dbg" if tool == "x32dbg" else tool, {})
    runtime = record.get("runtime", {})
    command = runtime.get("command")
    if runtime.get("type") == "http":
        python = state.get("http_bridge_python")
        if python and Path(python).is_file():
            command = [python, str(Path(__file__).with_name("http_stdio.py")), tool]
    if not command or not isinstance(command, list) or not Path(command[0]).is_file():
        status_server(tool, record.get("message", "This tool was not found or has not deployed successfully. Run dbg doctor, then load MCP in a new task."))
        return
    environment = {**os.environ, **runtime.get("env", {})}
    if os.name == "nt":
        # On Windows, CRT execve process replacement is unreliable with piped stdio; explicitly inherit all three standard streams.
        result = subprocess.run(command, env=environment, stdin=sys.stdin, stdout=sys.stdout,
                                stderr=sys.stderr, creationflags=subprocess.CREATE_NO_WINDOW)
        raise SystemExit(result.returncode)
    os.execve(command[0], command, environment)


if __name__ == "__main__":
    main()
