"""Dbg 的隔离运行时和上游版本解析；不修改系统 Python 或其他客户端配置。"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid
import venv

from dbg_core import DbgError, Downloader, atomic_json, managed_deploy


def run_command(command, *, cwd=None, timeout=600, env=None):
    """执行确定的参数列表，日志留在调用层；异常不回显可能含令牌的参数。"""
    try:
        result = subprocess.run(
            [str(x) for x in command], cwd=cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DbgError(f"无法完成子进程：{type(exc).__name__}") from exc
    if result.returncode:
        # 上游构建输出用于定位依赖问题，但不输出完整命令或环境变量。
        raise DbgError(f"子进程退出码 {result.returncode}: {result.stdout[-2400:]}")
    return result.stdout


class Context:
    """一次 doctor 的事务上下文；调用者必须已经持有机器数据目录的锁。"""

    def __init__(self, data_dir: Path, state: dict, backup_dir: Path):
        self.data_dir = data_dir
        self.state = state
        self.backup_dir = backup_dir
        self.downloader = Downloader(data_dir / "downloads")
        self.warnings: list[str] = []
        self._releases: dict[str, dict] = {}

    def save(self):
        atomic_json(self.data_dir / "state.json", self.state)

    def stage(self, name: str, version: str) -> Path:
        label = re.sub(r"[^a-zA-Z0-9._-]", "_", name)[:80]
        revision = hashlib.sha256(version.encode()).hexdigest()[:20]
        path = self.data_dir / "staging" / label / revision
        path.mkdir(parents=True, exist_ok=True)
        return path

    def latest_release(self, repo: str) -> dict:
        if repo in self._releases:
            return self._releases[repo]
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise DbgError("无效的上游仓库标识")
        releases = self.state.setdefault("releases", {})
        try:
            release = self.downloader.json(f"https://api.github.com/repos/{repo}/releases/latest")
            if release.get("draft") or release.get("prerelease") or not release.get("tag_name"):
                raise DbgError(f"{repo} 未返回稳定发布")
            releases[repo] = release
        except DbgError:
            if repo not in releases:
                raise
            release = releases[repo]
            self.warnings.append(f"{repo} 无法检查更新，本次使用上次已解析版本")
        self._releases[repo] = release
        return release

    def resolve_commit(self, repo: str, ref: str = "HEAD") -> str:
        from urllib.parse import quote
        data = self.downloader.json(
            f"https://api.github.com/repos/{repo}/commits/{quote(ref, safe='')}"
        )
        revision = data.get("sha", "")
        if not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise DbgError(f"{repo} 无法解析精确提交")
        return revision

    def deploy(self, files: dict[Path, Path]) -> list[str]:
        changed = managed_deploy(files, self.state, self.backup_dir)
        self.save()
        return changed

    def ensure_runtime(self, name: str, requirements: list[str]) -> Path:
        """构建隔离 venv；失败或修复使用新目录，保留此前能运行的环境。"""
        key = hashlib.sha256(json.dumps(
            [name, requirements, sys.version_info[:2]], sort_keys=True
        ).encode()).hexdigest()[:24]
        cache = self.state.setdefault("runtimes", {})
        modules = []
        module_map = {"mcp-windbg": "mcp_windbg", "ida-pro-mcp": "ida_pro_mcp"}
        for requirement in requirements:
            package = re.split(r"[<>=\[]", requirement)[0]
            if re.fullmatch(r"[\w-]+", package):
                modules.append(module_map.get(package, package.replace("-", "_")))
        probe = "import importlib; " + "; ".join(
            f"importlib.import_module({module!r})" for module in modules
        )
        if key in cache:
            python = Path(cache[key])
            if python.is_file():
                try:
                    run_command([python, "-c", probe], timeout=30)
                    run_command([python, "-m", "pip", "check"], timeout=30)
                    return python
                except DbgError:
                    pass
        folder = self.data_dir / "runtimes" / (key + "-" + uuid.uuid4().hex[:8])
        folder.parent.mkdir(parents=True, exist_ok=True)
        try:
            venv.EnvBuilder(with_pip=True).create(folder)
        except (OSError, subprocess.SubprocessError) as exc:
            raise DbgError("创建隔离 Python 环境失败") from exc
        python = folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        run_command([
            python, "-m", "pip", "install", "--disable-pip-version-check",
            "--no-input", *requirements,
        ], timeout=900)
        run_command([python, "-m", "pip", "check"], timeout=60)
        run_command([python, "-c", probe], timeout=60)
        cache[key] = str(python)
        self.save()
        return python
