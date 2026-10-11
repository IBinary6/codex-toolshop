"""Shared file, download, and deployment primitives for the Dbg plugin."""

from __future__ import annotations

import contextlib
import errno
import hashlib
import http.client
import json as json_module
import os
import re
import shutil
import socket
import stat
import tempfile
import time
import urllib.parse
import urllib.request
import urllib.error
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


class DbgError(Exception):
    """An operation failure that can be explained to Dbg callers."""


def default_data_dir() -> Path:
    """Return the platform Dbg data directory without creating it."""

    override = os.environ.get("DBG_HOME")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        return (Path(local_app_data) if local_app_data else Path.home() / "AppData/Local") / "Dbg"
    if _platform_name() == "darwin":
        return Path.home() / "Library/Application Support/Dbg"
    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    return (Path(xdg_data_home) if xdg_data_home else Path.home() / ".local/share") / "dbg"


def _platform_name() -> str:
    # Lazy imports let file-only callers avoid loading platform-specific modules.
    import sys

    return sys.platform


def load_json(path: Path, default: Any = None) -> Any:
    """Read UTF-8 JSON; return ``default`` if the file does not exist."""

    try:
        with Path(path).open("r", encoding="utf-8") as source:
            return json_module.load(source)
    except FileNotFoundError:
        return default
    except (OSError, UnicodeError, json_module.JSONDecodeError) as exc:
        raise DbgError(f"Cannot read JSON file {path}: {exc}") from exc


def atomic_json(path: Path, value: Any) -> None:
    """Write UTF-8 JSON in the target directory and commit via atomic replacement."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        descriptor, raw_temporary = tempfile.mkstemp(
            prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
        )
        temporary = Path(raw_temporary)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            # Escape non-ASCII JSON text while retaining UTF-8 files and compatibility with Windows default-code-page readers.
            json_module.dump(value, output, ensure_ascii=True, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        temporary = None
    except (OSError, TypeError, ValueError) as exc:
        raise DbgError(f"Cannot write JSON file {destination}: {exc}") from exc
    finally:
        if temporary is not None:
            with contextlib.suppress(OSError):
                temporary.unlink()


class FileLock:
    """Cross-platform process advisory lock, released by the OS when the process exits."""

    def __init__(self, path: Path, timeout: float = 120) -> None:
        self.path = Path(path)
        self.timeout = timeout
        self._file: Any = None

    def __enter__(self) -> "FileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = self.path.open("a+b")
        if os.name == "nt" and self.path.stat().st_size == 0:
            self._file.write(b"\0")
            self._file.flush()

        deadline = time.monotonic() + self.timeout
        while True:
            try:
                self._try_lock()
                return self
            except (BlockingIOError, OSError) as exc:
                if not self._is_busy_error(exc) or time.monotonic() >= deadline:
                    self._file.close()
                    self._file = None
                    if self._is_busy_error(exc):
                        raise DbgError(f"Timed out waiting for file lock: {self.path}") from exc
                    raise DbgError(f"Cannot lock file {self.path}: {exc}") from exc
                time.sleep(0.05)

    def _try_lock(self) -> None:
        assert self._file is not None
        self._file.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(self._file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    @staticmethod
    def _is_busy_error(exc: OSError) -> bool:
        # On some Python/Windows combinations, msvcrt.locking contention reports only errno=EACCES,
        # without winerror. Treat these values as contention only after the lock file has been opened successfully.
        busy_errnos = {errno.EACCES, errno.EAGAIN, errno.EDEADLK}
        if hasattr(errno, "EDEADLOCK"):
            busy_errnos.add(errno.EDEADLOCK)
        return (
            isinstance(exc, BlockingIOError)
            or getattr(exc, "errno", None) in busy_errnos
            or getattr(exc, "winerror", None) in {33, 36}
        )

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if self._file is None:
            return
        try:
            self._file.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self._file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
        finally:
            self._file.close()
            self._file = None


def sha256_file(path: Path) -> str:
    """Compute a file SHA-256 hex digest."""

    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class Downloader:
    """HTTPS downloader with digest validation and stable cache naming."""

    def __init__(self, cache_dir: Path, timeout: float = 30) -> None:
        self.cache_dir = Path(cache_dir)
        self.timeout = timeout

    def _cache_path(self, url: str) -> Path:
        parsed = urllib.parse.urlsplit(url)
        basename = Path(urllib.parse.unquote(parsed.path)).name or "download"
        basename = re.sub(r"[^A-Za-z0-9._-]", "_", basename)[:100] or "download"
        url_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()
        return self.cache_dir / f"{url_hash}-{basename}"

    @staticmethod
    def _digest_path(cache_path: Path) -> Path:
        return cache_path.with_name(f"{cache_path.name}.sha256.json")

    @staticmethod
    def _validate_url(url: str) -> None:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme == "https" and parsed.hostname:
            return
        if parsed.scheme == "http" and parsed.hostname:
            try:
                is_loopback = parsed.hostname == "localhost" or socket.gethostbyname(
                    parsed.hostname
                ).startswith("127.")
            except OSError:
                is_loopback = False
            if is_loopback or parsed.hostname == "::1":
                return
        raise DbgError("Download URLs must use HTTPS; HTTP is allowed only for loopback tests")

    def _download_temporary(self, url: str, destination: Path) -> tuple[Path, str]:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            descriptor, raw_temporary = tempfile.mkstemp(
                prefix=f".{destination.name}.", suffix=".tmp", dir=self.cache_dir
            )
            temporary = Path(raw_temporary)
            with os.fdopen(descriptor, "wb") as output:
                request = urllib.request.Request(url)
                parsed = urllib.parse.urlsplit(url)
                if parsed.scheme == "https" and parsed.netloc.lower() == "api.github.com":
                    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
                    if token:
                        if any(character in token for character in ("\r", "\n", "\0")):
                            raise DbgError("Invalid GitHub token format")
                        # Use an existing token only for GitHub API; urllib redirects do not copy these headers.
                        request.add_unredirected_header("Authorization", f"Bearer {token}")
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    output.write(response.read())
                output.flush()
                os.fsync(output.fileno())
            actual = sha256_file(temporary)
            result = temporary
            temporary = None
            return result, actual
        except DbgError:
            raise
        except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException) as exc:
            raise DbgError(f"Download failed {url}: {exc}") from exc
        finally:
            if temporary is not None:
                with contextlib.suppress(OSError):
                    temporary.unlink()

    def _cache_is_valid(self, destination: Path, expected: str | None) -> bool:
        if not destination.is_file():
            return False
        try:
            actual = sha256_file(destination)
        except OSError:
            return False
        if expected is not None:
            # An upstream digest verifies both origin and local integrity, without relying on our sidecar.
            return actual == expected
        try:
            metadata = load_json(self._digest_path(destination), default={})
        except DbgError:
            return False
        return (
            isinstance(metadata, dict)
            and metadata.get("sha256") == actual
            and re.fullmatch(r"[0-9a-f]{64}", actual) is not None
        )

    def _commit_cache(self, temporary: Path, destination: Path, digest: str) -> None:
        os.replace(temporary, destination)
        atomic_json(self._digest_path(destination), {"sha256": digest})

    def fetch(self, url: str, sha256: str | None = None) -> Path:
        """Download and cache a resource; a local sidecar detects damage when no upstream digest exists."""

        self._validate_url(url)
        expected = sha256.lower() if sha256 else None
        if expected and not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise DbgError("Invalid SHA-256 digest")
        destination = self._cache_path(url)
        if self._cache_is_valid(destination, expected):
            return destination

        temporary: Path | None = None
        try:
            temporary, actual = self._download_temporary(url, destination)
            if expected is not None and actual != expected:
                raise DbgError(f"Downloaded file failed SHA-256 validation: {url}")
            self._commit_cache(temporary, destination, actual)
            temporary = None
            return destination
        except DbgError:
            raise
        except OSError as exc:
            raise DbgError(f"Cannot update download cache {destination}: {exc}") from exc
        finally:
            if temporary is not None:
                with contextlib.suppress(OSError):
                    temporary.unlink()

    def json(self, url: str) -> dict[str, Any]:
        """Fetch a fresh JSON object each time; replace local cache only after successful parsing and validation."""

        self._validate_url(url)
        destination = self._cache_path(url)
        temporary: Path | None = None
        try:
            temporary, digest = self._download_temporary(url, destination)
            try:
                with temporary.open("r", encoding="utf-8") as source:
                    value = json_module.load(source)
            except (OSError, UnicodeError, json_module.JSONDecodeError) as exc:
                raise DbgError(f"Invalid JSON response {url}: {exc}") from exc
            if not isinstance(value, dict):
                raise DbgError(f"Top-level JSON response must be an object: {url}")
            self._commit_cache(temporary, destination, digest)
            temporary = None
            return value
        except DbgError:
            raise
        except OSError as exc:
            raise DbgError(f"Cannot update JSON cache {destination}: {exc}") from exc
        finally:
            if temporary is not None:
                with contextlib.suppress(OSError):
                    temporary.unlink()


def _safe_member_path(name: str) -> PurePosixPath:
    normalized = name.replace("\\", "/")
    if not normalized or normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise DbgError(f"ZIP contains an unsafe path: {name}")
    member_path = PurePosixPath(normalized)
    if any(part in {"", ".", ".."} for part in member_path.parts):
        raise DbgError(f"ZIP contains an unsafe path: {name}")
    return member_path


def safe_extract_zip(archive: Path, destination: Path) -> None:
    """Validate all ZIP entries before extraction; reject symlinks and path traversal."""

    try:
        with zipfile.ZipFile(archive) as source:
            validated: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
            for info in source.infolist():
                member_path = _safe_member_path(info.filename)
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    raise DbgError(f"ZIP symlinks are not allowed: {info.filename}")
                validated.append((info, member_path))

            output_root = Path(destination)
            output_root.mkdir(parents=True, exist_ok=True)
            for info, member_path in validated:
                output_path = output_root.joinpath(*member_path.parts)
                if info.is_dir():
                    output_path.mkdir(parents=True, exist_ok=True)
                    continue
                output_path.parent.mkdir(parents=True, exist_ok=True)
                with source.open(info) as input_file, output_path.open("wb") as output_file:
                    shutil.copyfileobj(input_file, output_file)
    except DbgError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        raise DbgError(f"Cannot extract ZIP file {archive}: {exc}") from exc


def _copy_for_replace(source: Path, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw_temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    os.close(descriptor)
    temporary = Path(raw_temporary)
    try:
        shutil.copy2(source, temporary)
        return temporary
    except Exception:
        with contextlib.suppress(OSError):
            temporary.unlink()
        raise


def managed_deploy(
    files: dict[Path, Path], state: dict[str, Any], backup_dir: Path
) -> list[str]:
    """Deploy managed files, refuse conflicting overwrites, and restore replaced targets on failure when possible."""

    existing_records = state.get("managed_files", {})
    if not isinstance(existing_records, dict):
        raise DbgError("managed_files in state must be an object")

    plans: list[dict[str, Any]] = []
    for target_value, source_value in files.items():
        target = Path(target_value).expanduser().resolve()
        source = Path(source_value).expanduser().resolve()
        key = str(target)
        try:
            if not source.is_file():
                raise DbgError(f"Deployment source does not exist: {source}")
            new_hash = sha256_file(source)
            target_exists = target.is_file()
            current_hash = sha256_file(target) if target_exists else None
        except OSError as exc:
            raise DbgError(f"Cannot preflight deployment target {target}: {exc}") from exc

        recorded_hash = existing_records.get(key)
        if target.exists() and not target_exists:
            raise DbgError(f"Deployment target is not a regular file: {target}")
        if target_exists and recorded_hash is None and current_hash != new_hash:
            raise DbgError(f"Refusing to overwrite a file not managed by Dbg: {target}")
        if (
            target_exists
            and recorded_hash is not None
            and current_hash not in {recorded_hash, new_hash}
        ):
            raise DbgError(f"Managed file was modified by the user; refusing to overwrite: {target}")
        plans.append(
            {
                "target": target,
                "source": source,
                "key": key,
                "new_hash": new_hash,
                "current_hash": current_hash,
                "change": current_hash != new_hash,
            }
        )

    changed_plans = [plan for plan in plans if plan["change"]]
    backups: dict[str, Path | None] = {}
    try:
        for plan in changed_plans:
            target = plan["target"]
            if target.is_file():
                Path(backup_dir).mkdir(parents=True, exist_ok=True)
                identity = hashlib.sha256(str(target).encode("utf-8")).hexdigest()[:16]
                backup = Path(backup_dir) / f"{identity}-{target.name}.bak"
                shutil.copy2(target, backup)
                backups[plan["key"]] = backup
            else:
                backups[plan["key"]] = None
    except OSError as exc:
        raise DbgError(f"Cannot back up managed file: {exc}") from exc

    applied: list[dict[str, Any]] = []
    temporary: Path | None = None
    try:
        for plan in changed_plans:
            temporary = _copy_for_replace(plan["source"], plan["target"])
            os.replace(temporary, plan["target"])
            temporary = None
            applied.append(plan)
    except OSError as exc:
        if temporary is not None:
            with contextlib.suppress(OSError):
                temporary.unlink()
        rollback_errors: list[str] = []
        for plan in reversed(applied):
            target = plan["target"]
            backup = backups[plan["key"]]
            try:
                if backup is None:
                    target.unlink(missing_ok=True)
                else:
                    restore = _copy_for_replace(backup, target)
                    os.replace(restore, target)
            except OSError as rollback_exc:
                rollback_errors.append(f"{target}: {rollback_exc}")
        detail = f"; rollback failed: {'; '.join(rollback_errors)}" if rollback_errors else ""
        raise DbgError(f"File deployment failed: {exc}{detail}") from exc

    updated_records = dict(existing_records)
    for plan in plans:
        updated_records[plan["key"]] = plan["new_hash"]
    state["managed_files"] = updated_records
    return [plan["key"] for plan in changed_plans]
