"""Dbg isolated runtime and upstream version resolution; do not change system Python or other client configuration."""
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
    """Run a fixed argument list; leave logging to callers and do not echo potentially sensitive arguments in exceptions."""
    try:
        result = subprocess.run(
            [str(x) for x in command], cwd=cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DbgError(f"Could not complete subprocess: {type(exc).__name__}") from exc
    if result.returncode:
        # Upstream build output helps diagnose dependencies; do not print the full command or environment.
        raise DbgError(f"Subprocess exit code {result.returncode}: {result.stdout[-2400:]}")
    return result.stdout


class Context:
    """Transactional context for one doctor run; the caller must already hold the machine data-directory lock."""

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
            raise DbgError("Invalid upstream repository identifier")
        releases = self.state.setdefault("releases", {})
        try:
            release = self.downloader.json(f"https://api.github.com/repos/{repo}/releases/latest")
            if release.get("draft") or release.get("prerelease") or not release.get("tag_name"):
                raise DbgError(f"{repo} did not return a stable release")
            releases[repo] = release
        except DbgError:
            if repo not in releases:
                raise
            release = releases[repo]
            self.warnings.append(f"{repo} Could not check updates; using the previously resolved version for this run")
        self._releases[repo] = release
        return release

    def resolve_commit(self, repo: str, ref: str = "HEAD") -> str:
        from urllib.parse import quote
        data = self.downloader.json(
            f"https://api.github.com/repos/{repo}/commits/{quote(ref, safe='')}"
        )
        revision = data.get("sha", "")
        if not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise DbgError(f"{repo} Could not resolve an exact commit")
        return revision

    def deploy(self, files: dict[Path, Path]) -> list[str]:
        changed = managed_deploy(files, self.state, self.backup_dir)
        self.save()
        return changed

    def ensure_runtime(
        self, name: str, requirements: list[str], *, import_modules: list[str] | None = None,
        find_modules: list[str] | None = None,
    ) -> Path:
        """Build an isolated venv in a new directory on failure or repair, preserving the previous working environment."""
        modules = []
        module_map = {"mcp-windbg": "mcp_windbg", "ida-pro-mcp": "ida_pro_mcp"}
        for requirement in requirements:
            package = re.split(r"[<>=\[]", requirement)[0]
            if re.fullmatch(r"[\w-]+", package):
                modules.append(module_map.get(package, package.replace("-", "_")))
        for module in import_modules or []:
            if not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", module):
                raise DbgError("Invalid isolated-runtime import module name")
            modules.append(module)
        modules = list(dict.fromkeys(modules))
        findable = list(dict.fromkeys(find_modules or []))
        if any(not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", x) for x in findable):
            raise DbgError("Invalid isolated-runtime entry module name")
        key_parts = [name, requirements, sys.version_info[:2]]
        if import_modules is not None or find_modules is not None:
            key_parts.extend((modules, findable))
        key = hashlib.sha256(json.dumps(key_parts, sort_keys=True).encode()).hexdigest()[:24]
        cache = self.state.setdefault("runtimes", {})
        checks = [f"importlib.import_module({module!r})" for module in modules]
        checks.extend(
            f"if importlib.util.find_spec({module!r}) is None:\n"
            f"    raise ModuleNotFoundError({module!r})" for module in findable
        )
        probe = "import importlib, importlib.util\n" + "\n".join(checks)
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
            raise DbgError("Failed to create isolated Python environment") from exc
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
