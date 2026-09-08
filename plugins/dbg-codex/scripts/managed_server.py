"""从 Dbg 状态启动上游 MCP；未安装工具返回真实状态，不假冒可用调试能力。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import subprocess

from dbg_core import default_data_dir, load_json


def select_http_runtime(state, tool):
    record = state.get("tools", {}).get("x64dbg" if tool == "x32dbg" else tool, {})
    if tool == "x32dbg":
        instances = [x for x in record.get("instances", []) if x.get("architecture") == "x32"]
        return instances[0].get("runtime", {}) if instances else {}
    return record.get("runtime", {})


def status_server(tool: str, message: str):
    """极小的 stdio 状态服务使未安装的可选工具不会造成整个插件加载失败。"""
    name = "dbg_" + tool.replace("-", "_") + "_status"
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if "id" not in request:
                continue
            method = request.get("method")
            if method == "initialize":
                result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "dbg-" + tool, "version": "0.1.1"}}
            elif method == "tools/list":
                result = {"tools": [{"name": name, "description": "显示此调试工具的部署状态", "inputSchema": {"type": "object", "properties": {}}}]}
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
        status_server(tool, record.get("message", "未发现或尚未成功部署该工具。执行 dbg doctor 后，在新任务中加载 MCP。"))
        return
    environment = {**os.environ, **runtime.get("env", {})}
    if os.name == "nt":
        # Windows CRT 的 execve 覆盖进程在管道 stdio 下不可靠；显式继承三个标准流。
        result = subprocess.run(command, env=environment, stdin=sys.stdin, stdout=sys.stdout,
                                stderr=sys.stderr, creationflags=subprocess.CREATE_NO_WINDOW)
        raise SystemExit(result.returncode)
    os.execve(command[0], command, environment)


if __name__ == "__main__":
    main()
