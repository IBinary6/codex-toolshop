"""官方调试器扩展的确定性安装适配器。"""

from __future__ import annotations

import hashlib
import json
import os
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
        raise DbgError(f"上游返回的稳定版本无效: {raw or '<empty>'}")
    return version


def _release_asset(release: dict[str, Any], expected_name: str) -> tuple[str, str | None]:
    if release.get("draft") or release.get("prerelease"):
        raise DbgError("拒绝使用草稿或预发布版本")
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise DbgError("上游发布缺少资产列表")
    matches = [item for item in assets if isinstance(item, dict) and item.get("name") == expected_name]
    if len(matches) != 1:
        raise DbgError(f"上游发布必须且只能包含一个 {expected_name}")
    url = matches[0].get("browser_download_url")
    if not isinstance(url, str) or not url.startswith("https://"):
        raise DbgError(f"上游资产 {expected_name} 缺少 HTTPS 下载地址")
    digest = matches[0].get("digest")
    if digest is None:
        return url, None
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
        raise DbgError(f"上游资产 {expected_name} 的摘要格式无效")
    return url, digest.split(":", 1)[1].lower()


def _read_x64dbg_config(
    path: Path, default_port: int
) -> tuple[dict[str, Any], str, bool]:
    config: dict[str, Any] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise DbgError(f"无法安全更新 x64dbg MCP 配置 {path}: {exc}") from exc
        if not isinstance(loaded, dict):
            raise DbgError(f"x64dbg MCP 配置必须是 JSON 对象: {path}")
        config = loaded

    # 只有同时含上游地址和端口键的文件才允许进入首次窄接管流程。
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

    # 只收敛插件实际读取的安全关键键，其他上游或用户键原样保留。
    auto_start = config.get("AutoStart")
    if not isinstance(auto_start, bool):
        auto_start = True
    critical = {
        "IpAddress": "127.0.0.1",
        "Port": port,
        "AutoStart": auto_start,
        "AuthToken": token,
    }
    # 上游只读取文件前 512 字节，关键键必须排在保留的未知键之前。
    critical.update({key: value for key, value in config.items() if key not in critical})
    return critical, token, recognizable


def _write_staged_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        # 保留 _read_x64dbg_config 建立的关键键优先顺序；插件只读取前 512 字节。
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _adopt_x64dbg_configs(
    configs: list[tuple[Path, bool]], ctx: Any
) -> tuple[bool, dict[str, Any]]:
    """备份并登记可识别的旧配置，使唯一一次受管部署可安全迁移它。"""

    had_records = "managed_files" in ctx.state
    existing_records = ctx.state.get("managed_files", {})
    if not isinstance(existing_records, dict):
        raise DbgError("状态中的 managed_files 必须是对象")
    original = dict(existing_records)
    records = dict(existing_records)
    pending: list[tuple[Path, str, str]] = []
    for target, recognizable in configs:
        key = str(target.expanduser().resolve())
        if not target.exists() or key in records:
            continue
        if not target.is_file() or not recognizable:
            raise DbgError(f"拒绝接管无法识别的非 Dbg 配置: {target}")
        pending.append((target, key, sha256_file(target)))

    # 所有候选先完成备份，之后才在内存中登记所有权，避免半接管状态。
    for target, key, _ in pending:
        try:
            ctx.backup_dir.mkdir(parents=True, exist_ok=True)
            identity = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
            backup = ctx.backup_dir / f"{identity}-adopted-{target.name}.bak"
            shutil.copy2(target, backup)
        except OSError as exc:
            raise DbgError(f"首次接管前无法备份 x64dbg MCP 配置 {target}: {exc}") from exc
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
        raise DbgError("x64dbg MCP 发布包缺少预期的 x32/x64 插件")

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
            raise DbgError(f"x64dbg 安装目录缺少 x64dbg.exe/x32dbg.exe: {root}")

    if primary_runtime is None:
        raise DbgError("没有可部署的 x64dbg 实例")
    ownership_snapshot = _adopt_x64dbg_configs(config_adoptions, ctx)
    try:
        deployed = ctx.deploy(files)
    except Exception:
        # deploy 失败时不能让后续 save 把临时接管记录写成真实所有权。
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
        raise DbgError("PyPI 响应缺少 info")
    version = _stable_version(info.get("version"))
    urls = payload.get("urls")
    if not isinstance(urls, list) or not any(
        isinstance(item, dict) and not item.get("yanked", False) for item in urls
    ):
        raise DbgError(f"PyPI {version} 没有可安装的稳定文件")
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
        # mcp-windbg 1.2.x 的公开命令行契约支持 KD_PATH/--kd-path。
        env["KD_PATH"] = str(kd)
    if "CDB_PATH" not in env and "KD_PATH" not in env:
        raise DbgError(f"mcp-windbg 需要 cdb.exe 或 kd.exe，当前目录仅有 GUI WinDbg: {root}")
    return {"type": "stdio", "command": [str(python), "-m", "mcp_windbg"], "env": env}


def install_windbg(installations: list[Any], ctx: Any) -> dict[str, Any]:
    payload = ctx.downloader.json(WINDBG_PYPI)
    version = _pypi_stable_version(payload)
    python = ctx.ensure_runtime(f"windbg-{version}", [f"mcp-windbg=={version}"])
    instances = [
        {"root": str(item.root), "architecture": item.architecture, "runtime": _windbg_runtime(item, python, ctx)}
        for item in installations
    ]
    if not instances:
        raise DbgError("没有可配置的 WinDbg 命令行调试器")
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
        raise DbgError("没有可配置的 IDA Pro")
    unsupported: list[str] = []
    for item in installations:
        parsed = _ida_version_tuple(item.version)
        if parsed is None:
            unsupported.append("未知版本")
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
            raise DbgError("Windows 缺少 APPDATA，无法确定 IDA 用户插件目录")
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
        raise DbgError("无法从隔离运行时定位 ida-pro-mcp 插件文件") from exc
    path = Path(result.stdout.strip())
    if not path.is_file():
        raise DbgError(f"ida-pro-mcp {IDA_MCP_VERSION} 包缺少 {relative}")
    return path


def install_ida_mcp(installations: list[Any], ctx: Any) -> dict[str, Any]:
    if any(getattr(item, "edition", "") == "free" for item in installations):
        return {"status": "unsupported", "version": IDA_MCP_VERSION, "files": [],
                "message": "检测到 IDA Free，不提供 IDAPython API；未部署 Python MCP 插件"}
    unsupported = _unsupported_ida_versions(installations)
    if unsupported:
        versions = ", ".join(sorted(set(unsupported)))
        return {
            "status": "unsupported",
            "version": IDA_MCP_VERSION,
            "source": f"https://pypi.org/project/ida-pro-mcp/{IDA_MCP_VERSION}/",
            "message": f"ida-pro-mcp {IDA_MCP_VERSION} 最低支持 IDA 8.3；检测到 {versions}，未部署",
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
        raise DbgError("没有可配置的 IDA Pro")
    if any(getattr(item, "edition", "") == "free" for item in installations):
        return {"status": "unsupported", "version": "unresolved", "files": [],
                "message": "检测到 IDA Free，不提供 IDAPython API；未部署 Python 导出插件"}
    unsupported: list[str] = []
    for item in installations:
        parsed = _ida_version_tuple(item.version)
        if parsed is None:
            unsupported.append("未知版本")
        elif parsed < (9, 0):
            unsupported.append(str(item.version))
    if unsupported:
        versions = ", ".join(sorted(set(unsupported)))
        reason = (
            "无法确认当前 IDA 版本兼容性"
            if "未知版本" in unsupported
            else "IDA-NO-MCP 上游未声明 oldpython/INP.py 支持 IDA 8.x"
        )
        return {
            "status": "unsupported",
            "version": "unresolved",
            "source": f"https://github.com/{IDA_EXPORT_REPO}",
            "message": f"{reason}；检测到 {versions}，未部署",
            "files": [],
        }
    revision = ctx.resolve_commit(IDA_EXPORT_REPO)
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise DbgError(f"{IDA_EXPORT_REPO} 返回了无效提交哈希")
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
