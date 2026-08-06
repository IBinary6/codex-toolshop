#!/usr/bin/env python3
"""首次加载插件时启用 Codex 系统代理功能。"""

from __future__ import annotations

import contextlib
import dataclasses
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterator, Sequence

from setup_proxy import MIN_CODEX_VERSION, codex_home_from_env


class SessionStartError(RuntimeError):
    """表示 SessionStart 无法安全启用代理功能。"""


@dataclasses.dataclass(frozen=True)
class SessionStartResult:
    """描述自动配置的可观察结果。"""

    changed: bool
    initialized: bool


class CodexClient:
    """通过公开 Codex CLI 管理功能开关。"""

    def __init__(self, command: Sequence[str] | None = None, *, codex_home: Path | None = None):
        """构造指向指定 Codex 主目录的 CLI 客户端。"""

        executable = shutil.which("codex")
        if command is None and not executable:
            raise SessionStartError("未找到 codex 命令")
        self.command = list(command or [executable or "codex"])
        self.environment = os.environ.copy()
        if codex_home:
            self.environment["CODEX_HOME"] = str(codex_home)

    def _run(self, arguments: Sequence[str]) -> str:
        """执行 Codex CLI 并把失败转换为 Hook 诊断。"""

        try:
            result = subprocess.run(
                [*self.command, *arguments],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
                env=self.environment,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise SessionStartError(f"Codex 命令执行失败: {error}") from error
        if result.returncode != 0:
            diagnostic = (result.stderr or result.stdout).strip()
            raise SessionStartError(f"Codex 命令失败: {diagnostic or result.returncode}")
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", result.stdout)

    def version(self) -> str:
        """返回 Codex CLI 的语义版本。"""

        output = self._run(["--version"])
        match = re.search(r"(\d+\.\d+\.\d+)", output)
        if not match:
            raise SessionStartError("无法解析 Codex CLI 版本")
        return match.group(1)

    def feature_enabled(self, name: str) -> bool:
        """查询指定功能是否存在且启用。"""

        output = self._run(["features", "list"])
        match = re.search(rf"(?m)^\s*{re.escape(name)}\s+.*?\s+(true|false)\s*$", output)
        if not match:
            raise SessionStartError(f"当前 Codex 不支持功能 {name}")
        return match.group(1) == "true"

    def enable_feature(self, name: str) -> None:
        """通过官方命令启用指定功能。"""

        self._run(["features", "enable", name])


def _version_tuple(value: str) -> tuple[int, int, int]:
    """把 Codex 语义版本前缀解析为三元组。"""

    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", value)
    if not match:
        raise SessionStartError(f"无法解析 Codex CLI 版本: {value}")
    return tuple(int(part) for part in match.groups())


def validate_codex_version(value: str) -> None:
    """确认 Codex 版本满足已验证的系统代理能力下限。"""

    if _version_tuple(value) < MIN_CODEX_VERSION:
        required = ".".join(str(part) for part in MIN_CODEX_VERSION)
        raise SessionStartError(f"Codex CLI {value} 过旧，需要 {required} 或更高版本")


@contextlib.contextmanager
def _initialization_lock(data_dir: Path) -> Iterator[bool]:
    """获取带陈旧锁回收的一次性初始化锁。"""

    data_dir.mkdir(parents=True, exist_ok=True)
    lock_path = data_dir / "initialize.lock"
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            if time.time() - lock_path.stat().st_mtime > 120:
                lock_path.unlink()
                descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            else:
                yield False
                return
        except (FileNotFoundError, FileExistsError):
            yield False
            return
    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        os.close(descriptor)
        yield True
    finally:
        with contextlib.suppress(OSError):
            lock_path.unlink()


def ensure_feature(client: CodexClient, data_dir: Path, *, force: bool = False) -> SessionStartResult:
    """首次运行时启用 `respect_system_proxy` 并记录初始化结果。"""

    data = Path(data_dir)
    marker = data / "initialized.json"
    if marker.exists() and not force:
        return SessionStartResult(False, True)
    with _initialization_lock(data) as acquired:
        if not acquired:
            return SessionStartResult(False, marker.exists())
        if marker.exists() and not force:
            return SessionStartResult(False, True)
        version = client.version()
        validate_codex_version(version)
        enabled = client.feature_enabled("respect_system_proxy")
        if not enabled:
            client.enable_feature("respect_system_proxy")
            if not client.feature_enabled("respect_system_proxy"):
                raise SessionStartError("respect_system_proxy 启用后验证失败")
        marker.write_text(
            json.dumps({"codex_version": version, "feature": "respect_system_proxy"}, indent=2) + "\n",
            encoding="utf-8",
        )
        return SessionStartResult(not enabled, True)


def _plugin_data_dir() -> Path:
    """解析插件的持久化数据目录。"""

    raw = os.environ.get("PLUGIN_DATA")
    if raw:
        return Path(raw).expanduser().resolve()
    return codex_home_from_env() / "plugins" / "data" / "system-proxy-codex"


def _hook_output(message: str) -> None:
    """输出符合 Codex SessionStart 协议的附加上下文。"""

    payload = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": message,
        }
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def main() -> int:
    """执行 SessionStart；错误转为可操作的 Hook 诊断。"""

    try:
        result = ensure_feature(CodexClient(codex_home=codex_home_from_env()), _plugin_data_dir())
        if result.changed:
            _hook_output(
                "System Proxy for Codex 已启用 respect_system_proxy。请完整退出并重新打开 Codex，使代理配置生效。"
            )
    except (OSError, SessionStartError) as error:
        _hook_output(f"System Proxy for Codex 自动配置失败：{error}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
