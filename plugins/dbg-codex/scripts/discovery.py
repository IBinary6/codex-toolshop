"""在受控路径中发现本机调试与逆向工具安装。"""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from dbg_core import DbgError


TOOLS = ("x64dbg", "ghidra", "ida", "windbg")


@dataclass(frozen=True)
class Installation:
    tool: str
    root: Path
    version: str = ""
    architecture: str = ""
    source: str = ""


def _existing_file(root: Path, relative_names: Iterable[str]) -> Path | None:
    for relative_name in relative_names:
        candidate = root / relative_name
        if candidate.is_file():
            return candidate
    return None


def _version_from_name(root: Path) -> str:
    for part in reversed(root.parts):
        match = re.search(r"(?<!\d)(\d+(?:\.\d+){1,3})(?!\d)", part)
        if match:
            return match.group(1)
    return ""


def _ghidra_version(root: Path) -> str:
    properties = root / "Ghidra" / "application.properties"
    try:
        for line in properties.read_text(encoding="utf-8", errors="replace").splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() == "application.version":
                return value.strip()
    except OSError:
        pass
    return _version_from_name(root)


def _resolved(path: Path) -> Path:
    try:
        return path.expanduser().resolve()
    except OSError:
        return path.expanduser().absolute()


def _resolve_scoop_shim(path: Path) -> Path:
    """通过 Scoop 的同名 .shim 元数据解析包装脚本，失败时保留原路径。"""

    if not path.is_file():
        return path
    metadata_path = path if path.suffix.lower() == ".shim" else path.with_suffix(".shim")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        target_value = metadata.get("path") if isinstance(metadata, dict) else None
        if not isinstance(target_value, str) or not target_value:
            return path
        target = Path(target_value).expanduser()
        if not target.is_absolute():
            target = metadata_path.parent / target
        target = _resolved(target)
        return target if target.is_file() else path
    except (OSError, ValueError):
        return path


def detect_at(tool: str, path: Path | str, source: str = "") -> Installation | None:
    """核对一个明确位置并规范化安装根目录，不在其下递归扫描。"""

    if tool not in TOOLS:
        return None
    candidate = _resolved(Path(path))
    if tool == "ghidra":
        candidate = _resolve_scoop_shim(candidate)
    if candidate.is_file():
        candidate = candidate.parent

    if tool == "x64dbg":
        possible_roots = (candidate, candidate / "release")
        if candidate.name.lower() in {"x64", "x32"}:
            possible_roots = (candidate.parent,)
        for root in possible_roots:
            x64 = root / "x64" / "x64dbg.exe"
            x32 = root / "x32" / "x32dbg.exe"
            if x64.is_file() or x32.is_file():
                architecture = "x64" if x64.is_file() else "x86"
                return Installation(
                    tool, _resolved(root), _version_from_name(root), architecture, source
                )
        return None

    if tool == "ghidra":
        possible_roots = (candidate,)
        # Scoop 清单有时把包根指向只包含一个 Ghidra 发布目录的上层。
        try:
            children = tuple(
                child
                for child in candidate.iterdir()
                if child.is_dir() and child.name.lower().startswith("ghidra")
            )
            possible_roots += children
        except OSError:
            pass
        for root in possible_roots:
            properties = root / "Ghidra" / "application.properties"
            if (
                _existing_file(root, ("ghidraRun.bat", "ghidraRun.sh", "ghidraRun"))
                and properties.is_file()
            ):
                normalized = _resolved(root)
                return Installation(tool, normalized, _ghidra_version(normalized), source=source)
        return None

    if tool == "ida":
        app_root = candidate
        if candidate.name == "MacOS" and candidate.parent.name == "Contents":
            app_root = candidate.parent.parent
        mac_binary_root = app_root / "Contents" / "MacOS"
        if _existing_file(mac_binary_root, ("ida", "ida64")):
            return Installation(tool, _resolved(app_root), _version_from_name(app_root), source=source)
        if _existing_file(candidate, ("ida.exe", "ida64.exe", "ida", "ida64")):
            architecture = "x64" if _existing_file(candidate, ("ida64.exe", "ida64")) else ""
            return Installation(
                tool, _resolved(candidate), _version_from_name(candidate), architecture, source
            )
        return None

    executable = _existing_file(candidate, ("cdb.exe", "kd.exe", "cdb", "kd"))
    if executable:
        architecture = next(
            (part.lower() for part in reversed(candidate.parts) if part.lower() in {"x64", "x86", "arm64"}),
            "",
        )
        return Installation(
            tool, _resolved(candidate), _version_from_name(candidate), architecture, source
        )
    return None


def _read_scoop_config(home: Path) -> list[Path]:
    roots: list[Path] = []
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    for config_path in (config_home / "scoop/config.json", home / "scoop/config.json"):
        try:
            value = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(value, dict):
            continue
        for key in ("root_path", "global_path"):
            configured = value.get(key)
            if isinstance(configured, str) and configured:
                roots.append(Path(configured).expanduser())
    return roots


def _scoop_roots() -> list[Path]:
    home = Path.home()
    candidates = [
        Path(value)
        for value in (os.environ.get("SCOOP"), os.environ.get("SCOOP_GLOBAL"))
        if value
    ]
    candidates.extend((home / "scoop", Path(os.environ.get("PROGRAMDATA", "C:/ProgramData")) / "scoop"))
    candidates.extend(_read_scoop_config(home))
    return _dedupe_paths(candidates)


def _scoop_app_candidates(scoop_root: Path, app_names: Iterable[str]) -> list[Path]:
    result: list[Path] = []
    for app_name in app_names:
        app_root = scoop_root / "apps" / app_name
        current = app_root / "current"
        if current.exists():
            result.append(current)
            # current 是 Scoop 唯一活动版本；旧版本可能仍用于回滚，不应重复部署扩展。
            continue
        try:
            # current 缺失时枚举固定层级，兼容未创建 current 链接的安装。
            result.extend(
                child
                for child in app_root.iterdir()
                if child.is_dir() and child.name.lower() not in {"current", "persist"}
            )
        except OSError:
            pass
    return result


def _path_candidates() -> dict[str, list[Path]]:
    names = {
        "x64dbg": ("x64dbg.exe", "x32dbg.exe"),
        "ghidra": ("ghidraRun.bat", "ghidraRun.sh", "ghidraRun"),
        "ida": ("ida64.exe", "ida.exe", "ida64", "ida"),
        "windbg": ("cdb.exe", "kd.exe", "cdb", "kd"),
    }
    result = {tool: [] for tool in TOOLS}
    for tool, executable_names in names.items():
        for executable_name in executable_names:
            located = shutil.which(executable_name)
            if located:
                result[tool].append(Path(located))
    return result


def _windows_registry_candidates() -> dict[str, list[Path]]:
    """读取有限的 App Paths 和卸载登记；非 Windows 返回空结果。"""

    result = {tool: [] for tool in TOOLS}
    if platform.system() != "Windows":
        return result
    try:
        import winreg
    except ImportError:
        return result

    app_paths = {
        "x64dbg": ("x64dbg.exe", "x32dbg.exe"),
        "ghidra": ("ghidraRun.bat",),
        "ida": ("ida64.exe", "ida.exe"),
        "windbg": ("cdb.exe", "kd.exe"),
    }
    access_modes = (winreg.KEY_READ, winreg.KEY_READ | getattr(winreg, "KEY_WOW64_32KEY", 0))
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for tool, executable_names in app_paths.items():
            for executable_name in executable_names:
                key_name = rf"Software\Microsoft\Windows\CurrentVersion\App Paths\{executable_name}"
                for access in access_modes:
                    try:
                        with winreg.OpenKey(hive, key_name, 0, access) as key:
                            value, _ = winreg.QueryValueEx(key, None)
                        if isinstance(value, str):
                            result[tool].append(Path(value.strip('"')))
                    except OSError:
                        pass

    uninstall_roots = (
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    )
    name_to_tool = (("x64dbg", "x64dbg"), ("ghidra", "ghidra"), ("ida", "ida"), ("windbg", "windbg"))
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for uninstall_root in uninstall_roots:
            try:
                with winreg.OpenKey(hive, uninstall_root) as root_key:
                    subkey_count = winreg.QueryInfoKey(root_key)[0]
                    for index in range(subkey_count):
                        try:
                            with winreg.OpenKey(root_key, winreg.EnumKey(root_key, index)) as app_key:
                                display_name, _ = winreg.QueryValueEx(app_key, "DisplayName")
                                install_location, _ = winreg.QueryValueEx(app_key, "InstallLocation")
                        except OSError:
                            continue
                        lowered = str(display_name).lower()
                        for marker, tool in name_to_tool:
                            if marker in lowered and isinstance(install_location, str) and install_location:
                                result[tool].append(Path(install_location))
                                break
            except OSError:
                pass
    return result


def _merge_candidates(
    destination: dict[str, list[Path]], source: dict[str, list[Path]]
) -> None:
    for tool in TOOLS:
        destination[tool].extend(source.get(tool, ()))


def _automatic_candidates() -> dict[str, list[Path]]:
    result = {tool: [] for tool in TOOLS}
    system = platform.system()
    if system == "Windows":
        scoop_names = {
            "x64dbg": ("x64dbg",),
            "ghidra": ("ghidra",),
            "ida": ("ida", "ida-free"),
            "windbg": ("windbg", "windows-debugging-tools"),
        }
        for scoop_root in _scoop_roots():
            for tool, names in scoop_names.items():
                result[tool].extend(_scoop_app_candidates(scoop_root, names))
        program_files_x86 = Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)"))
        result["windbg"].append(program_files_x86 / "Windows Kits/10/Debuggers/x64")
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            result["windbg"].append(Path(local_app_data) / "Microsoft/WindowsApps")
        _merge_candidates(result, _windows_registry_candidates())
    else:
        home = Path.home()
        application_roots = [Path("/Applications"), home / "Applications"] if system == "Darwin" else []
        for applications in application_roots:
            result["ida"].extend(
                applications / name
                for name in ("IDA Professional.app", "IDA.app", "IDA Free.app")
            )
        result["ghidra"].extend((Path("/opt/ghidra"), home / "ghidra"))
        result["ida"].extend((Path("/opt/ida"), home / "ida"))

    _merge_candidates(result, _path_candidates())
    return {tool: _dedupe_paths(paths) for tool, paths in result.items()}


def _dedupe_paths(paths: Iterable[Path]) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        normalized = _resolved(Path(path))
        key = os.path.normcase(str(normalized))
        if key not in seen:
            seen.add(key)
            result.append(normalized)
    return result


def discover(overrides: dict[str, list[str]] | None = None) -> list[Installation]:
    """按显式覆盖、自动候选的顺序返回全部已确认安装。"""

    if overrides is None:
        override_values: dict[str, list[str]] = {}
    elif not isinstance(overrides, dict):
        raise DbgError("paths 必须是以工具名为键的对象")
    else:
        override_values = overrides
    for tool, values in override_values.items():
        if tool not in TOOLS:
            raise DbgError(f"paths 包含未知工具: {tool}")
        if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
            raise DbgError(f"paths.{tool} 必须是字符串路径数组")
    automatic = _automatic_candidates()
    found: list[Installation] = []
    seen: set[tuple[str, str]] = set()

    phases = (
        ("override", {tool: override_values.get(tool, ()) for tool in TOOLS}),
        ("auto", automatic),
    )
    for source, candidates_by_tool in phases:
        for tool in TOOLS:
            for value in candidates_by_tool.get(tool, ()):
                installation = detect_at(tool, Path(value), source)
                if installation is None:
                    continue
                key = (installation.tool, os.path.normcase(str(installation.root)))
                if key in seen:
                    continue
                seen.add(key)
                found.append(installation)
    return found
