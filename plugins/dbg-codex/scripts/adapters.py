"""Deterministic installation adapters for official debugger extensions."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
from pathlib import Path
from typing import Any

from dbg_core import DbgError, safe_extract_zip, sha256_file


X64DBG_REPO = "duty1g/x64dbg-mcp-server"
WINDBG_PYPI = "https://pypi.org/pypi/mcp-windbg/json"
IDA_MCP_VERSION = "1.4.0"
IDA_EXPORT_REPO = "P4nda0s/IDA-NO-MCP"


def _stable_version(value: object, *, prefix: str = "") -> str:
    raw = str(value or "")
    version = raw[len(prefix) :] if prefix and raw.startswith(prefix) else raw
    if not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", version):
        raise DbgError(f"Invalid stable version returned by upstream: {raw or '<empty>'}")
    return version


def _release_asset(release: dict[str, Any], expected_name: str) -> tuple[str, str | None]:
    if release.get("draft") or release.get("prerelease"):
        raise DbgError("Draft and prerelease versions are not allowed")
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise DbgError("Upstream release has no asset list")
    matches = [item for item in assets if isinstance(item, dict) and item.get("name") == expected_name]
    if len(matches) != 1:
        raise DbgError(f"Upstream release must contain exactly one {expected_name}")
    url = matches[0].get("browser_download_url")
    if not isinstance(url, str) or not url.startswith("https://"):
        raise DbgError(f"Upstream asset {expected_name} has no HTTPS download URL")
    digest = matches[0].get("digest")
    if digest is None:
        return url, None
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
        raise DbgError(f"Upstream asset {expected_name} has an invalid digest format")
    return url, digest.split(":", 1)[1].lower()


def _read_x64dbg_config(
    path: Path, default_port: int
) -> tuple[dict[str, Any], str, bool]:
    config: dict[str, Any] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise DbgError(f"Cannot safely update x64dbg MCP configuration {path}: {exc}") from exc
        if not isinstance(loaded, dict):
            raise DbgError(f"x64dbg MCP configuration must be a JSON object: {path}")
        config = loaded

    # Only files with both upstream address and port keys qualify for narrow first-time adoption.
    recognizable = {"IpAddress", "Port"}.issubset(config)
    token = config.get("AuthToken")
    if (
        not isinstance(token, str)
        or not re.fullmatch(r"[\x21-\x7e]{1,64}", token)
        or '"' in token
        or "\\" in token
    ):
        token = secrets.token_hex(16)
    port = config.get("Port")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        port = default_port

    # Set only security-critical keys read by the plugin; preserve all other upstream or user keys.
    auto_start = config.get("AutoStart")
    if not isinstance(auto_start, bool):
        auto_start = True
    critical = {
        "IpAddress": "127.0.0.1",
        "Port": port,
        "AutoStart": auto_start,
        "AuthToken": token,
    }
    # Upstream reads only the first 512 bytes, so critical keys must precede preserved unknown keys.
    critical.update({key: value for key, value in config.items() if key not in critical})
    return critical, token, recognizable


def _write_staged_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        # Preserve the critical-key ordering established by _read_x64dbg_config; the plugin reads only the first 512 bytes.
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _adopt_x64dbg_configs(
    configs: list[tuple[Path, bool]], ctx: Any
) -> tuple[bool, dict[str, Any]]:
    """Back up and register recognizable legacy configuration for one safe managed migration."""

    had_records = "managed_files" in ctx.state
    existing_records = ctx.state.get("managed_files", {})
    if not isinstance(existing_records, dict):
        raise DbgError("managed_files in state must be an object")
    original = dict(existing_records)
    records = dict(existing_records)
    pending: list[tuple[Path, str, str]] = []
    for target, recognizable in configs:
        key = str(target.expanduser().resolve())
        if not target.exists() or key in records:
            continue
        if not target.is_file() or not recognizable:
            raise DbgError(f"Refusing to adopt unrecognized non-Dbg configuration: {target}")
        pending.append((target, key, sha256_file(target)))

    # Back up every candidate before registering ownership in memory to avoid partial adoption.
    for target, key, _ in pending:
        try:
            ctx.backup_dir.mkdir(parents=True, exist_ok=True)
            identity = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
            backup = ctx.backup_dir / f"{identity}-adopted-{target.name}.bak"
            shutil.copy2(target, backup)
        except OSError as exc:
            raise DbgError(f"Cannot back up x64dbg MCP configuration before first adoption {target}: {exc}") from exc
    for _, key, current_hash in pending:
        records[key] = current_hash
    if pending:
        ctx.state["managed_files"] = records
    return had_records, original


def _restore_managed_records(ctx: Any, snapshot: tuple[bool, dict[str, Any]]) -> None:
    had_records, records = snapshot
    if had_records:
        ctx.state["managed_files"] = records
    else:
        ctx.state.pop("managed_files", None)


def install_x64dbg(installations: list[Any], ctx: Any) -> dict[str, Any]:
    release = ctx.latest_release(X64DBG_REPO)
    tag = release.get("tag_name")
    version = _stable_version(tag, prefix="v")
    asset_name = f"x64dbg-MCP-Server-v{version}.zip"
    url, digest = _release_asset(release, asset_name)
    archive = ctx.downloader.fetch(url, sha256=digest)
    stage = ctx.stage("x64dbg-mcp-server", version)
    extracted = stage / "archive" / secrets.token_hex(8)
    safe_extract_zip(archive, extracted)

    sources = {
        "x64": extracted / "x64/plugins/x64dbg-MCP-Server.dp64",
        "x32": extracted / "x32/plugins/x64dbg-MCP-Server.dp32",
    }
    if not all(source.is_file() for source in sources.values()):
        raise DbgError("x64dbg MCP release lacks the expected x32/x64 plugins")

    files: dict[Path, Path] = {}
    config_adoptions: list[tuple[Path, bool]] = []
    instances: list[dict[str, Any]] = []
    primary_runtime: dict[str, Any] | None = None
    for index, installation in enumerate(installations):
        root = Path(installation.root)
        found_architecture = False
        for architecture, executable, default_port in (
            ("x64", root / "x64/x64dbg.exe", 9094),
            ("x32", root / "x32/x32dbg.exe", 9095),
        ):
            if not executable.is_file():
                continue
            found_architecture = True
            target = executable.parent / "plugins" / sources[architecture].name
            files[target] = sources[architecture]
            config_target = executable.parent / "mcp_config.json"
            config, token, recognizable = _read_x64dbg_config(config_target, default_port)
            config_source = stage / "configs" / str(index) / architecture / "mcp_config.json"
            _write_staged_json(config_source, config)
            files[config_target] = config_source
            config_adoptions.append((config_target, recognizable))
            runtime = {
                "type": "http",
                "url": f"http://127.0.0.1:{config['Port']}/",
                "token": token,
            }
            instance = {
                "root": str(root),
                "architecture": architecture,
                "config": str(config_target),
                "runtime": runtime,
            }
            instances.append(instance)
            if primary_runtime is None or architecture == "x64":
                primary_runtime = runtime
        if not found_architecture:
            raise DbgError(f"x64dbg installation lacks x64dbg.exe/x32dbg.exe: {root}")

    if primary_runtime is None:
        raise DbgError("No deployable x64dbg instance")
    ownership_snapshot = _adopt_x64dbg_configs(config_adoptions, ctx)
    try:
        deployed = ctx.deploy(files)
    except Exception:
        # If deployment fails, a later save must not persist temporary adoption as real ownership.
        _restore_managed_records(ctx, ownership_snapshot)
        raise
    return {
        "version": version,
        "source": f"https://github.com/{X64DBG_REPO}/releases/tag/{tag}",
        "runtime": primary_runtime,
        "instances": instances,
        "simultaneous_default_ports": False,
        "files": deployed,
    }


def _pypi_stable_version(payload: dict[str, Any]) -> str:
    info = payload.get("info")
    if not isinstance(info, dict):
        raise DbgError("PyPI response lacks info")
    version = _stable_version(info.get("version"))
    urls = payload.get("urls")
    if not isinstance(urls, list) or not any(
        isinstance(item, dict) and not item.get("yanked", False) for item in urls
    ):
        raise DbgError(f"PyPI {version} has no installable stable file")
    return version


def _windbg_runtime(installation: Any, python: Path, ctx: Any) -> dict[str, Any]:
    root = Path(installation.root)
    cdb = root / "cdb.exe"
    kd = root / "kd.exe"
    env: dict[str, str] = {
        "_NT_SYMBOL_PATH": os.environ.get(
            "_NT_SYMBOL_PATH",
            f"SRV*{ctx.data_dir / 'symbols'}*https://msdl.microsoft.com/download/symbols",
        )
    }
    if cdb.is_file():
        env["CDB_PATH"] = str(cdb)
    if kd.is_file():
        # The public mcp-windbg 1.2.x command-line contract supports KD_PATH/--kd-path.
        env["KD_PATH"] = str(kd)
    if "CDB_PATH" not in env and "KD_PATH" not in env:
        raise DbgError(f"mcp-windbg needs cdb.exe or kd.exe; this directory has only GUI WinDbg: {root}")
    return {"type": "stdio", "command": [str(python), "-m", "mcp_windbg"], "env": env}


def install_windbg(installations: list[Any], ctx: Any) -> dict[str, Any]:
    from windbg import backend_mode, legacy_available
    mode = backend_mode(getattr(ctx, "config", {}))
    native = [item for item in installations if (Path(item.root) / "DbgX.Mcp.Proxy.exe").is_file()]
    legacy = [item for item in installations if any((Path(item.root) / name).is_file() for name in ("cdb.exe", "kd.exe"))]
    if mode != "legacy" and native and platform.system() == "Windows":
        item = native[0]
        previous = ctx.state.get("tools", {}).get("windbg", {})
        backup = previous.get("legacy_runtime", previous.get("runtime", {}))
        metadata = {
            "backend": "native", "backend_mode": mode, "version": item.version or "",
            "source": "https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/windbg-mcp-overview",
            "runtime": {"type": "stdio", "command": [str(Path(item.root) / "DbgX.Mcp.Proxy.exe")], "env": {}},
            "files": [],
            "message": "Official WinDbg MCP proxy ready; enable MCP Service in the intended WinDbg window. Codex support is best-effort.",
        }
        if legacy_available(backup):
            metadata["legacy_runtime"] = backup
            metadata["legacy_version"] = previous.get("legacy_version", previous.get("version", ""))
        return metadata
    if mode == "native":
        return {"status": "unsupported", "backend_mode": mode, "message": "Official DbgX.Mcp.Proxy.exe not found or platform unsupported; native mode does not fall back. Install current WinDbg or configure paths.windbg."}
    if not legacy:
        return {"status": "unsupported", "backend_mode": mode, "message": "No usable WinDbg backend: official proxy unavailable and legacy requires cdb.exe or kd.exe."}
    result = _install_windbg_legacy(legacy, ctx)
    result.update({"backend": "legacy", "backend_mode": mode})
    if mode == "auto":
        result["message"] = "Official WinDbg proxy unavailable; deployed the legacy cdb/kd compatibility backend."
    return result


def _install_windbg_legacy(installations: list[Any], ctx: Any) -> dict[str, Any]:
    payload = ctx.downloader.json(WINDBG_PYPI)
    version = _pypi_stable_version(payload)
    python = ctx.ensure_runtime(f"windbg-{version}", [f"mcp-windbg=={version}"])
    instances = [
        {"root": str(item.root), "architecture": item.architecture, "runtime": _windbg_runtime(item, python, ctx)}
        for item in installations
    ]
    if not instances:
        raise DbgError("No configurable WinDbg command-line debugger")
    deployed = ctx.deploy({})
    return {
        "version": version,
        "source": f"https://pypi.org/project/mcp-windbg/{version}/",
        "runtime": instances[0]["runtime"],
        "instances": instances,
        "files": deployed,
    }


def _ida_version_tuple(value: object) -> tuple[int, ...] | None:
    if value is None or value == "":
        return None
    match = re.match(r"^(\d+)(?:\.(\d+))?", str(value))
    if not match:
        return None
    return tuple(int(part or 0) for part in match.groups())


def _unsupported_ida_versions(installations: list[Any]) -> list[str]:
    if not installations:
        raise DbgError("No configurable IDA Pro installation")
    unsupported: list[str] = []
    for item in installations:
        parsed = _ida_version_tuple(item.version)
        if parsed is None:
            unsupported.append("unknown version")
        elif parsed < (8, 3):
            unsupported.append(str(item.version))
    return unsupported


def _ida_plugin_dir() -> Path:
    override = os.environ.get("IDAUSR")
    if override:
        return Path(override).expanduser() / "plugins"
    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        if not appdata:
            raise DbgError("APPDATA is missing on Windows; cannot locate the IDA user plugin directory")
        return Path(appdata) / "Hex-Rays" / "IDA Pro" / "plugins"
    return Path.home() / ".idapro" / "plugins"


def _locate_package_file(python: Path, relative: str) -> Path:
    code = (
        "import pathlib, ida_pro_mcp; "
        f"print(pathlib.Path(ida_pro_mcp.__file__).resolve().parent / {relative!r})"
    )
    try:
        result = subprocess.run(
            [str(python), "-c", code],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise DbgError("Cannot locate ida-pro-mcp plugin files in isolated runtime") from exc
    path = Path(result.stdout.strip())
    if not path.is_file():
        raise DbgError(f"ida-pro-mcp {IDA_MCP_VERSION} package lacks {relative}")
    return path


def install_ida_mcp(installations: list[Any], ctx: Any) -> dict[str, Any]:
    if any(getattr(item, "edition", "") == "free" for item in installations):
        return {"status": "unsupported", "version": IDA_MCP_VERSION, "files": [],
                "message": "IDA Free detected without IDAPython API; Python MCP plugin not deployed"}
    unsupported = _unsupported_ida_versions(installations)
    if unsupported:
        versions = ", ".join(sorted(set(unsupported)))
        return {
            "status": "unsupported",
            "version": IDA_MCP_VERSION,
            "source": f"https://pypi.org/project/ida-pro-mcp/{IDA_MCP_VERSION}/",
            "message": f"ida-pro-mcp {IDA_MCP_VERSION} requires IDA 8.3 or newer; found {versions} and was not deployed",
            "files": [],
        }
    python = ctx.ensure_runtime(
        f"ida-pro-mcp-{IDA_MCP_VERSION}", [f"ida-pro-mcp=={IDA_MCP_VERSION}"]
    )
    plugin_source = _locate_package_file(python, "mcp-plugin.py")
    plugin_target = _ida_plugin_dir() / "mcp-plugin.py"
    runtime = {"type": "stdio", "command": [str(python), "-m", "ida_pro_mcp"], "env": {}}
    deployed = ctx.deploy({plugin_target: plugin_source})
    return {
        "version": IDA_MCP_VERSION,
        "source": f"https://pypi.org/project/ida-pro-mcp/{IDA_MCP_VERSION}/",
        "runtime": runtime,
        "plugin": str(plugin_target),
        "files": deployed,
    }


def install_ida_export(installations: list[Any], ctx: Any) -> dict[str, Any]:
    if not installations:
        raise DbgError("No configurable IDA Pro installation")
    if any(getattr(item, "edition", "") == "free" for item in installations):
        return {"status": "unsupported", "version": "unresolved", "files": [],
                "message": "IDA Free detected without IDAPython API; Python export plugin not deployed"}
    unsupported: list[str] = []
    for item in installations:
        parsed = _ida_version_tuple(item.version)
        if parsed is None:
            unsupported.append("unknown version")
        elif parsed < (9, 0):
            unsupported.append(str(item.version))
    if unsupported:
        versions = ", ".join(sorted(set(unsupported)))
        reason = (
            "Cannot confirm compatibility with this IDA version"
            if "unknown version" in unsupported
            else "IDA-NO-MCP upstream does not declare support for oldpython/INP.py on IDA 8.x"
        )
        return {
            "status": "unsupported",
            "version": "unresolved",
            "source": f"https://github.com/{IDA_EXPORT_REPO}",
            "message": f"{reason}; found {versions} and was not deployed",
            "files": [],
        }
    revision = ctx.resolve_commit(IDA_EXPORT_REPO)
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise DbgError(f"{IDA_EXPORT_REPO} returned an invalid commit hash")
    url = f"https://raw.githubusercontent.com/{IDA_EXPORT_REPO}/{revision}/oldpython/INP.py"
    source = ctx.downloader.fetch(url)
    target = _ida_plugin_dir() / "INP.py"
    deployed = ctx.deploy({target: source})
    return {
        "version": revision,
        "source": f"https://github.com/{IDA_EXPORT_REPO}/commit/{revision}",
        "runtime": {
            "type": "ida-plugin",
            "menu": "Edit > Plugins > Export for AI",
            "shortcut": "Ctrl+Shift+E",
        },
        "plugin": str(target),
        "files": deployed,
    }
