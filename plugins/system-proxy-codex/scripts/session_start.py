#!/usr/bin/env python3
"""Enable Codex system proxy support on the first plugin load."""

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
    """Indicate that SessionStart cannot safely enable proxy support."""


@dataclasses.dataclass(frozen=True)
class SessionStartResult:
    """Describe the observable automatic setup result."""

    changed: bool
    initialized: bool


class CodexClient:
    """Manage feature flags through the public Codex CLI."""

    def __init__(self, command: Sequence[str] | None = None, *, codex_home: Path | None = None):
        """Create a CLI client for the specified Codex home."""

        executable = shutil.which("codex")
        if command is None and not executable:
            raise SessionStartError("codex command not found")
        self.command = list(command or [executable or "codex"])
        self.environment = os.environ.copy()
        if codex_home:
            self.environment["CODEX_HOME"] = str(codex_home)

    def _run(self, arguments: Sequence[str]) -> str:
        """Run the Codex CLI and convert failures into hook diagnostics."""

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
            raise SessionStartError(f"Codex command execution failed: {error}") from error
        if result.returncode != 0:
            diagnostic = (result.stderr or result.stdout).strip()
            raise SessionStartError(f"Codex command failed: {diagnostic or result.returncode}")
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", result.stdout)

    def version(self) -> str:
        """Return the semantic version of the Codex CLI."""

        output = self._run(["--version"])
        match = re.search(r"(\d+\.\d+\.\d+)", output)
        if not match:
            raise SessionStartError("Cannot parse Codex CLI version")
        return match.group(1)

    def feature_enabled(self, name: str) -> bool:
        """Check whether the specified feature exists and is enabled."""

        output = self._run(["features", "list"])
        match = re.search(rf"(?m)^\s*{re.escape(name)}\s+.*?\s+(true|false)\s*$", output)
        if not match:
            raise SessionStartError(f"Current Codex does not support feature {name}")
        return match.group(1) == "true"

    def enable_feature(self, name: str) -> None:
        """Enable the specified feature through the official command."""

        self._run(["features", "enable", name])


def _version_tuple(value: str) -> tuple[int, int, int]:
    """Parse a Codex semantic version prefix into a three-part tuple."""

    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", value)
    if not match:
        raise SessionStartError(f"Cannot parse Codex CLI version: {value}")
    return tuple(int(part) for part in match.groups())


def validate_codex_version(value: str) -> None:
    """Check the minimum Codex version verified for system proxy support."""

    if _version_tuple(value) < MIN_CODEX_VERSION:
        required = ".".join(str(part) for part in MIN_CODEX_VERSION)
        raise SessionStartError(f"Codex CLI {value} is too old; {required} or later is required")


@contextlib.contextmanager
def _initialization_lock(data_dir: Path) -> Iterator[bool]:
    """Acquire the one-time initialization lock with stale lock recovery."""

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
    """Enable respect_system_proxy on first run and record initialization."""

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
                raise SessionStartError("Verification failed after enabling respect_system_proxy")
        marker.write_text(
            json.dumps({"codex_version": version, "feature": "respect_system_proxy"}, indent=2) + "\n",
            encoding="utf-8",
        )
        return SessionStartResult(not enabled, True)


def _plugin_data_dir() -> Path:
    """Resolve the persistent plugin data directory."""

    raw = os.environ.get("PLUGIN_DATA")
    if raw:
        return Path(raw).expanduser().resolve()
    return codex_home_from_env() / "plugins" / "data" / "system-proxy-codex"


def _hook_output(message: str) -> None:
    """Emit additional context using the Codex SessionStart protocol."""

    payload = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": message,
        }
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def main() -> int:
    """Run SessionStart and convert errors into actionable hook diagnostics."""

    try:
        result = ensure_feature(CodexClient(codex_home=codex_home_from_env()), _plugin_data_dir())
        if result.changed:
            _hook_output(
                "System Proxy for Codex enabled respect_system_proxy. Fully quit and reopen Codex to apply proxy settings."
            )
    except (OSError, SessionStartError) as error:
        _hook_output(f"System Proxy for Codex automatic setup failed: {error}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
