"""WinDbg 后端策略；检查文件和元数据，不启动调试器或改变安全设置。"""
from __future__ import annotations

from pathlib import Path

from dbg_core import DbgError


def backend_mode(config: dict) -> str:
    settings = config.get("windbg", {})
    if not isinstance(settings, dict):
        raise DbgError("windbg must be an object")
    mode = settings.get("backend", "auto")
    if mode not in ("auto", "native", "legacy"):
        raise DbgError("windbg.backend must be auto, native, or legacy")
    return mode


def command_available(runtime: dict) -> bool:
    command = runtime.get("command")
    return (isinstance(command, list) and bool(command)
            and all(isinstance(value, str) for value in command)
            and Path(command[0]).is_file())


def legacy_available(runtime: dict) -> bool:
    """备份必须来自 mcp-windbg，并同时保有解释器和至少一个实际调试引擎。"""
    if not isinstance(runtime, dict) or not command_available(runtime):
        return False
    if runtime["command"][1:] != ["-m", "mcp_windbg"]:
        return False
    environment = runtime.get("env", {})
    return isinstance(environment, dict) and any(
        isinstance(environment.get(key), str) and Path(environment[key]).is_file()
        for key in ("CDB_PATH", "KD_PATH")
    )
