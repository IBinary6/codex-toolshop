"""Install the ``dbg`` command entry point managed by Dbg."""

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


# Public winreg constant values are stable across Python platforms; avoid importing a Windows module in unit tests.
REG_SZ = 1
REG_EXPAND_SZ = 2


class DeployContext(Protocol):
    """Minimal doctor context interface needed by command installation."""

    data_dir: Path
    state: dict[str, Any]

    def stage(self, name: str, version: str) -> Path: ...

    def deploy(self, files: dict[Path, Path]) -> list[str]: ...

    def save(self) -> None: ...


class RegistryAccess(Protocol):
    """Isolate Windows registry side effects for side-effect-free tests."""

    def read_path(self) -> tuple[str, int] | None: ...

    def write_path(self, value: str, kind: int) -> None: ...

    def broadcast_environment_change(self) -> bool: ...


class WindowsUserEnvironment:
    """Read and write only the current user  ``HKCU\\Environment\\Path``."""

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
            raise DbgError(f"Cannot read current-user PATH: {exc}") from exc
        if not isinstance(value, str):
            raise DbgError("Current-user PATH is not a string; refusing to modify it")
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
            raise DbgError(f"Cannot update current-user PATH: {exc}") from exc

    def broadcast_environment_change(self) -> bool:
        """Notify desktop processes to refresh the environment; failure does not undo an already persisted PATH."""

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
    """Return one argument safe to insert directly into a POSIX ``sh`` command line."""

    return shlex.quote(value)


def _checked_file(path: Path, label: str) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        raise DbgError(f"{label} must use an absolute path")
    try:
        if not candidate.is_file():
            raise DbgError(f"{label} does not exist or is not a regular file: {candidate}")
        return candidate.resolve()
    except OSError as exc:
        raise DbgError(f"Cannot inspect {label}: {candidate}: {exc}") from exc


def _powershell_quoted(value: Path, label: str) -> str:
    raw = str(value)
    if any(character in raw for character in ('\0', "\r", "\n")):
        raise DbgError(f"{label} contains characters that cannot be quoted safely")
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
        raise DbgError(f"Cannot prepare dbg command entry point: {exc}") from exc
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
            raise DbgError(f"Unsupported registry type for current-user PATH: {kind}")
    if _path_contains_windows(value, directory, environ):
        return False, []

    cli_state = context.state.setdefault("cli", {})
    if not isinstance(cli_state, dict):
        raise DbgError("cli in state must be an object")
    if "windows_user_path_backup" not in cli_state:
        backup: dict[str, Any] = {"present": current is not None}
        if current is not None:
            backup.update({"value": value, "kind": kind})
        cli_state["windows_user_path_backup"] = backup
        # Persist recovery information before changing the registry.
        context.save()

    separator = "" if not value or value.endswith(";") else ";"
    registry.write_path(f"{value}{separator}{directory}", kind)
    warnings: list[str] = []
    if not registry.broadcast_environment_change():
        warnings.append("PATH was written, but the environment refresh notification failed; reopen the terminal")
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
    """Install and register ``dbg``; return deployment changes and a PATH hint.

    Windows changes only current-user PATH. Unix does not guess the user shell, so return
    an explicit hint only when ``~/.local/bin`` is absent from PATH.
    """

    selected_os = os_name or os.name
    selected_home = Path(home) if home is not None else Path.home()
    selected_env = environ if environ is not None else os.environ
    resolved_node = _checked_file(node, "Node executable")
    resolved_launcher = _checked_file(launcher, "Dbg launcher")

    if selected_os == "nt":
        target = Path(context.data_dir).expanduser().resolve() / "bin" / "dbg.cmd"
        companion = target.with_name("dbg-cli.ps1")
        # Keep CMD files ASCII so active code pages such as CP936 do not corrupt plugin paths with non-ASCII characters.
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
            f"& {_powershell_quoted(resolved_node, 'Node path')} "
            f"{_powershell_quoted(resolved_launcher, 'Dbg launcher path')} @DbgArgs\n"
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
        raise DbgError(f"Unsupported platform for installing dbg command: {selected_os}")

    targets = [target] + ([companion] if companion is not None else [])
    for command_file in targets:
        if command_file.is_symlink():
            raise DbgError(f"Refusing to overwrite symlink at dbg command path: {command_file}")

    fingerprint_source = content + (companion_content or "")
    fingerprint = hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()[:20]
    source = context.stage("cli", fingerprint) / target.name
    _write_staged(source, content, executable=executable)
    deploy_files = {target: source}
    if companion is not None and companion_content is not None:
        companion_source = source.with_name(companion.name)
        # Windows PowerShell 5.1 needs a BOM to recognize non-ASCII script content correctly.
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
            raise DbgError(f"Cannot set executable permission on dbg command: {exc}") from exc
        if not _path_contains_posix(selected_env.get("PATH", ""), target.parent):
            export = f"export PATH={shell_quote(str(target.parent))}:\"$PATH\""
            path_hint = f"Run in the current terminal `{export}`; add the same line to the startup file for your shell"

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
