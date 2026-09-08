"""只读查询 Homebrew 安装前缀和已安装 cask artifact。"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Iterable


BREW_TIMEOUT_SECONDS = 8


def _resolved(path: Path) -> Path:
    try:
        return path.expanduser().resolve()
    except OSError:
        return path.expanduser().absolute()


def _dedupe_existing(paths: Iterable[Path]) -> list[Path]:
    found: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        normalized = _resolved(path)
        key = os.path.normcase(str(normalized))
        if normalized.is_dir() and key not in seen:
            seen.add(key)
            found.append(normalized)
    return found


def _default_prefixes(home: Path) -> list[Path]:
    return [
        Path("/opt/homebrew"),
        Path("/usr/local"),
        Path("/home/linuxbrew/.linuxbrew"),
        home / ".linuxbrew",
    ]


def _brew_environment() -> dict[str, str]:
    environment = dict(os.environ)
    environment["HOMEBREW_NO_AUTO_UPDATE"] = "1"
    environment["HOMEBREW_NO_ANALYTICS"] = "1"
    return environment


def _run_brew(brew: Path, arguments: list[str]) -> list[str] | None:
    """执行一个有界只读 brew 命令，失败时返回 None 供调用方降级。"""

    try:
        result = subprocess.run(
            [str(brew), *arguments],
            shell=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=BREW_TIMEOUT_SECONDS,
            env=_brew_environment(),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def homebrew_prefixes() -> list[Path]:
    """返回有环境、brew 命令或标准可执行文件证据的现存 Homebrew 前缀。"""

    candidates: list[Path] = []
    configured = os.environ.get("HOMEBREW_PREFIX")
    if configured:
        candidates.append(Path(configured))

    located = shutil.which("brew")
    if located:
        lines = _run_brew(Path(located), ["--prefix"])
        if lines:
            candidates.append(Path(lines[0]))

    try:
        home = Path.home()
    except RuntimeError:
        home = Path("/__dbg_missing_home__")
    for prefix in _default_prefixes(home):
        if (prefix / "bin" / "brew").is_file():
            candidates.append(prefix)
    return _dedupe_existing(candidates)


def _brew_executables(prefixes: Iterable[Path]) -> list[Path]:
    candidates: list[Path] = []
    located = shutil.which("brew")
    if located:
        candidates.append(Path(located))
    candidates.extend(Path(prefix) / "bin" / "brew" for prefix in prefixes)

    result: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized = _resolved(candidate)
        key = os.path.normcase(str(normalized))
        if normalized.is_file() and key not in seen:
            seen.add(key)
            result.append(normalized)
    return result


def _tool_for_cask(token: str) -> str | None:
    lowered = token.lower()
    if not re.fullmatch(r"[a-z0-9@+_.-]+", lowered):
        return None
    segments = re.split(r"[-_.@]+", lowered)
    if lowered.startswith("ghidra") or "ghidra" in segments:
        return "ghidra"
    if lowered.startswith("ida") or "ida" in segments:
        return "ida"
    return None


def _cask_artifact_roots(paths: Iterable[str]) -> list[Path]:
    """从 brew 的 find 输出提取直接目录、.app 链接或文件所属的 .app 根。"""

    roots: list[Path] = []
    for raw_path in paths:
        listed = Path(raw_path).expanduser()
        if not listed.is_absolute() or not listed.exists():
            continue
        if listed.is_dir():
            roots.append(listed)
            continue
        # 非 TTY 的 brew list 输出普通文件；只沿路径祖先查找，不扫描 Caskroom。
        for parent in listed.parents:
            if parent.name.lower().endswith(".app") and parent.is_dir():
                roots.append(parent)
                break
    return _dedupe_existing(roots)


def homebrew_cask_artifacts(prefixes: Iterable[Path] | None = None) -> dict[str, list[Path]]:
    """返回已安装 Ghidra/IDA 族 cask 报告的现存绝对 artifact 路径。"""

    prefix_list = list(prefixes) if prefixes is not None else homebrew_prefixes()
    artifacts: dict[str, list[Path]] = {"ghidra": [], "ida": []}
    for brew in _brew_executables(prefix_list):
        tokens = _run_brew(brew, ["list", "--cask", "-1"])
        if tokens is None:
            continue
        for token in tokens:
            tool = _tool_for_cask(token)
            if tool is None:
                continue
            paths = _run_brew(brew, ["list", "--cask", token])
            if paths is None:
                continue
            artifacts[tool].extend(_cask_artifact_roots(paths))
    return {tool: _dedupe_existing(paths) for tool, paths in artifacts.items()}
