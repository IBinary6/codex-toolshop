"""安装受 Dbg 管理的 ``dbg`` 命令入口。"""

from __future__ import annotations

import ctypes
import hashlib
import ntpath
import os
from pathlib import Path
import shlex
import stat
import tempfile
from typing import Any, Mapping, Protocol
import re

from dbg_core import DbgError


# winreg 的公开常量值在所有 Python 平台上保持一致；避免单元测试导入 Windows 模块。
REG_SZ = 1
REG_EXPAND_SZ = 2


class DeployContext(Protocol):
    """命令安装依赖的最小 doctor 上下文接口。"""

    data_dir: Path
    state: dict[str, Any]

    def stage(self, name: str, version: str) -> Path: ...

    def deploy(self, files: dict[Path, Path]) -> list[str]: ...

    def save(self) -> None: ...


class RegistryAccess(Protocol):
    """隔离 Windows 注册表副作用，便于无副作用测试。"""

    def read_path(self) -> tuple[str, int] | None: ...

    def write_path(self, value: str, kind: int) -> None: ...

    def broadcast_environment_change(self) -> bool: ...


class WindowsUserEnvironment:
    """只读写当前用户的 ``HKCU\\Environment\\Path``。"""

    def read_path(self) -> tuple[str, int] | None:
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                "Environment",
                0,
                winreg.KEY_QUERY_VALUE,
            ) as key:
                value, kind = winreg.QueryValueEx(key, "Path")
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise DbgError(f"无法读取当前用户 PATH: {exc}") from exc
        if not isinstance(value, str):
            raise DbgError("当前用户 PATH 不是字符串，拒绝修改")
        return value, kind

    def write_path(self, value: str, kind: int) -> None:
        try:
            import winreg

            with winreg.CreateKeyEx(
                winreg.HKEY_CURRENT_USER,
                "Environment",
                0,
                winreg.KEY_QUERY_VALUE | winreg.KEY_SET_VALUE,
            ) as key:
                winreg.SetValueEx(key, "Path", 0, kind, value)
        except OSError as exc:
            raise DbgError(f"无法更新当前用户 PATH: {exc}") from exc

    def broadcast_environment_change(self) -> bool:
        """通知桌面进程刷新环境；失败不撤销已经持久化的 PATH。"""

        try:
            result = ctypes.c_size_t()
            sent = ctypes.windll.user32.SendMessageTimeoutW(
                0xFFFF,  # HWND_BROADCAST
                0x001A,  # WM_SETTINGCHANGE
                0,
                ctypes.c_wchar_p("Environment"),
                0x0002,  # SMTO_ABORTIFHUNG
                5000,
                ctypes.byref(result),
            )
            return bool(sent)
        except (AttributeError, OSError):
            return False


def shell_quote(value: str) -> str:
    """返回可直接放进 POSIX ``sh`` 命令行的单个参数。"""

    return shlex.quote(value)


def _checked_file(path: Path, label: str) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        raise DbgError(f"{label} 必须使用绝对路径")
    try:
        if not candidate.is_file():
            raise DbgError(f"{label} 不存在或不是普通文件: {candidate}")
        return candidate.resolve()
    except OSError as exc:
        raise DbgError(f"无法检查 {label}: {candidate}: {exc}") from exc


def _powershell_quoted(value: Path, label: str) -> str:
    raw = str(value)
    if any(character in raw for character in ('\0', "\r", "\n")):
        raise DbgError(f"{label} 包含无法安全引用的字符")
    return "'" + raw.replace("'", "''") + "'"


def _write_staged(
    path: Path, content: str, *, executable: bool, encoding: str = "utf-8"
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        descriptor, raw_temporary = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        temporary = Path(raw_temporary)
        with os.fdopen(descriptor, "w", encoding=encoding, newline="\n") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        if executable:
            temporary.chmod(temporary.stat().st_mode | stat.S_IXUSR)
        os.replace(temporary, path)
        temporary = None
    except OSError as exc:
        raise DbgError(f"无法准备 dbg 命令入口: {exc}") from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def _expand_windows_variables(value: str, environ: Mapping[str, str]) -> str:
    folded = {key.casefold(): item for key, item in environ.items()}

    def replace(match: re.Match[str]) -> str:
        return folded.get(match.group(1).casefold(), match.group(0))

    return re.sub(r"%([^%]+)%", replace, value)


def _windows_path_key(value: str, environ: Mapping[str, str]) -> str:
    expanded = _expand_windows_variables(value.strip().strip('"'), environ)
    unquoted = expanded.rstrip("\\/")
    return ntpath.normcase(ntpath.normpath(unquoted)) if unquoted else ""


def _path_contains_windows(
    path_value: str, directory: Path, environ: Mapping[str, str]
) -> bool:
    wanted = _windows_path_key(str(directory), environ)
    return any(
        _windows_path_key(entry, environ) == wanted for entry in path_value.split(";")
    )


def _ensure_windows_path(
    context: DeployContext,
    directory: Path,
    registry: RegistryAccess,
    environ: Mapping[str, str],
) -> tuple[bool, list[str]]:
    current = registry.read_path()
    if current is None:
        value, kind = "", REG_EXPAND_SZ
    else:
        value, kind = current
        if kind not in {REG_SZ, REG_EXPAND_SZ}:
            raise DbgError(f"当前用户 PATH 的注册表类型不受支持: {kind}")
    if _path_contains_windows(value, directory, environ):
        return False, []

    cli_state = context.state.setdefault("cli", {})
    if not isinstance(cli_state, dict):
        raise DbgError("状态中的 cli 必须是对象")
    if "windows_user_path_backup" not in cli_state:
        backup: dict[str, Any] = {"present": current is not None}
        if current is not None:
            backup.update({"value": value, "kind": kind})
        cli_state["windows_user_path_backup"] = backup
        # 先持久化恢复信息，随后才改变注册表。
        context.save()

    separator = "" if not value or value.endswith(";") else ";"
    registry.write_path(f"{value}{separator}{directory}", kind)
    warnings: list[str] = []
    if not registry.broadcast_environment_change():
        warnings.append("PATH 已写入；系统环境刷新通知失败，请重新打开终端")
    return True, warnings


def _path_contains_posix(path_value: str, directory: Path) -> bool:
    wanted = os.path.normpath(str(directory))
    return any(
        os.path.normpath(entry.strip()) == wanted
        for entry in path_value.split(":")
        if entry.strip()
    )


def install_cli(
    context: DeployContext,
    launcher: Path,
    node: Path,
    *,
    os_name: str | None = None,
    home: Path | None = None,
    environ: Mapping[str, str] | None = None,
    registry: RegistryAccess | None = None,
) -> dict[str, Any]:
    """安装并注册 ``dbg``，返回部署变化和 PATH 提示。

    Windows 仅修改当前用户 PATH；Unix 不猜测用户使用的 shell，因此只在
    ``~/.local/bin`` 不在 PATH 时返回明确提示。
    """

    selected_os = os_name or os.name
    selected_home = Path(home) if home is not None else Path.home()
    selected_env = environ if environ is not None else os.environ
    resolved_node = _checked_file(node, "Node 可执行文件")
    resolved_launcher = _checked_file(launcher, "Dbg 启动脚本")

    if selected_os == "nt":
        target = Path(context.data_dir).expanduser().resolve() / "bin" / "dbg.cmd"
        companion = target.with_name("dbg-cli.ps1")
        # CMD 文件保持纯 ASCII，避免 CP936 等活动代码页破坏中文插件路径。
        content = (
            "@%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe "
            "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass "
            "-File \"%~dp0dbg-cli.ps1\" %*\n"
            "@exit /b %ERRORLEVEL%\n"
        )
        companion_content = (
            "param(\n"
            "    [Parameter(ValueFromRemainingArguments = $true)]\n"
            "    [string[]] $DbgArgs\n"
            ")\n"
            f"& {_powershell_quoted(resolved_node, 'Node 路径')} "
            f"{_powershell_quoted(resolved_launcher, 'Dbg 启动脚本路径')} @DbgArgs\n"
            "exit $LASTEXITCODE\n"
        )
        executable = False
    elif selected_os == "posix":
        target = selected_home.expanduser().resolve() / ".local" / "bin" / "dbg"
        companion = None
        companion_content = None
        content = (
            "#!/bin/sh\n"
            f"exec {shell_quote(str(resolved_node))} "
            f"{shell_quote(str(resolved_launcher))} \"$@\"\n"
        )
        executable = True
    else:
        raise DbgError(f"不支持安装 dbg 命令的平台: {selected_os}")

    targets = [target] + ([companion] if companion is not None else [])
    for command_file in targets:
        if command_file.is_symlink():
            raise DbgError(f"拒绝覆盖 dbg 命令位置的符号链接: {command_file}")

    fingerprint_source = content + (companion_content or "")
    fingerprint = hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()[:20]
    source = context.stage("cli", fingerprint) / target.name
    _write_staged(source, content, executable=executable)
    deploy_files = {target: source}
    if companion is not None and companion_content is not None:
        companion_source = source.with_name(companion.name)
        # Windows PowerShell 5.1 依赖 BOM 正确识别非 ASCII 脚本内容。
        _write_staged(
            companion_source,
            companion_content,
            executable=False,
            encoding="utf-8-sig",
        )
        deploy_files[companion] = companion_source
    deployed = context.deploy(deploy_files)

    warnings: list[str] = []
    path_changed = False
    path_hint: str | None = None
    if selected_os == "nt":
        selected_registry = registry or WindowsUserEnvironment()
        path_changed, warnings = _ensure_windows_path(
            context, target.parent, selected_registry, selected_env
        )
    else:
        try:
            target.chmod(target.stat().st_mode | stat.S_IXUSR)
        except OSError as exc:
            raise DbgError(f"无法设置 dbg 命令执行权限: {exc}") from exc
        if not _path_contains_posix(selected_env.get("PATH", ""), target.parent):
            export = f"export PATH={shell_quote(str(target.parent))}:\"$PATH\""
            path_hint = f"当前终端执行 `{export}`；并将同一行加入所用 shell 的启动文件"

    return {
        "target": str(target),
        "changed": bool(deployed) or path_changed,
        "path_changed": path_changed,
        "path_hint": path_hint,
        "warnings": warnings,
    }


__all__ = [
    "REG_EXPAND_SZ",
    "REG_SZ",
    "WindowsUserEnvironment",
    "install_cli",
    "shell_quote",
]
