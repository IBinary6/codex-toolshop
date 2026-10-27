"""Start upstream MCP from Dbg state; missing tools report their real status instead of claiming debugging capability."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import subprocess

from dbg_core import default_data_dir, load_json
from plugin_version import current_version
from windbg import backend_mode, command_available, legacy_available


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


def run_stdio(runtime):
    command = runtime["command"]
    environment = {**os.environ, **runtime.get("env", {})}
    if os.name == "nt":
        # 只有进程创建异常可以确认未连接；创建成功后的退出码不触发后端切换。
        result = subprocess.run(command, env=environment, stdin=sys.stdin, stdout=sys.stdout,
                                stderr=sys.stderr, creationflags=subprocess.CREATE_NO_WINDOW)
        return result.returncode
    os.execve(command[0], command, environment)


def start_native(runtime):
    return subprocess.Popen(runtime["command"], env={**os.environ, **runtime.get("env", {})},
                            stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


def run_windbg(record, mode):
    """auto 仅在原生进程未能创建时使用已验证备份；绝不重放会话命令。"""
    runtime = record.get("runtime", {})
    native = record.get("backend") == "native"
    if mode == "native" and not native:
        status_server("windbg", "Native backend is selected but not deployed. Run dbg doctor --tool windbg.")
        return 0
    if mode == "legacy" and native:
        runtime = record.get("legacy_runtime", {})
        if not legacy_available(runtime):
            status_server("windbg", "Legacy backend is selected but no usable backup exists. Run dbg doctor --tool windbg.")
            return 0
        native = False
    if not native:
        if not legacy_available(runtime):
            status_server("windbg", record.get("message", "WinDbg legacy backend is unavailable. Run dbg doctor --tool windbg."))
            return 0
        return run_stdio(runtime)
    try:
        if not command_available(runtime):
            raise FileNotFoundError("Official WinDbg proxy is missing")
        process = start_native(runtime)
    except OSError as exc:
        # 不吞掉进程创建之后的协议、session、secure mode 或 sampling 错误。
        backup = record.get("legacy_runtime", {})
        reason = f"Official WinDbg proxy could not start ({type(exc).__name__})."
        if mode == "auto" and legacy_available(backup):
            print(reason + " Using the saved legacy cdb/kd compatibility backend.", file=sys.stderr, flush=True)
            return run_stdio(backup)
        print(reason + " No automatic fallback is available; run dbg doctor --tool windbg.", file=sys.stderr, flush=True)
        return 1
    # wait 和运行期错误在创建异常处理范围之外，保留官方退出码。
    return process.wait()


def main():
    tool = sys.argv[1]
    state = load_json(default_data_dir() / "state.json", default={})
    record = state.get("tools", {}).get("x64dbg" if tool == "x32dbg" else tool, {})
    config = load_json(default_data_dir() / "config.json", default={})
    if ("x64dbg" if tool == "x32dbg" else tool) in config.get("disabled", []):
        status_server(tool, "This tool is disabled in Dbg config.json.")
        return
    if record.get("status") == "disabled":
        status_server(tool, "This tool is disabled. Run dbg doctor after enabling it.")
        return
    if tool == "windbg":
        raise SystemExit(run_windbg(record, backend_mode(config)))
    runtime = record.get("runtime", {})
    command = runtime.get("command")
    if runtime.get("type") == "http":
        python = state.get("http_bridge_python")
        if python and Path(python).is_file():
            command = [python, str(Path(__file__).with_name("http_stdio.py")), tool]
    if not command or not isinstance(command, list) or not Path(command[0]).is_file():
        status_server(tool, record.get("message", "This tool was not found or has not deployed successfully. Run dbg doctor, then load MCP in a new task."))
        return
    raise SystemExit(run_stdio({**runtime, "command": command}))


if __name__ == "__main__":
    main()
