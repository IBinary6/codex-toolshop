"""同一个 doctor 驱动首次部署、更新与修复，无需模型参与安装决策。"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

from dbg_core import DbgError, FileLock, atomic_json, default_data_dir, load_json
from discovery import discover
from runtime import Context

PLUGIN_VERSION = "0.1.2"
SCHEMA_VERSION = 1


def recipes():
    from adapters import install_ida_export, install_ida_mcp, install_windbg, install_x64dbg
    from ghidra_adapter import install_ghidra
    def x64dbg_with_transport(installations, context):
        context.state["http_bridge_python"] = str(context.ensure_runtime("http-bridge-v1", ["mcp>=1.9,<2"]))
        return install_x64dbg(installations, context)

    return {
        "x64dbg": ("x64dbg", x64dbg_with_transport),
        "ghidra": ("ghidra", install_ghidra),
        "windbg": ("windbg", install_windbg),
        "ida-mcp": ("ida", install_ida_mcp),
        "ida-export": ("ida", install_ida_export),
    }


def run_doctor(data_dir: Path, *, auto=False, selected=None, recipe_map=None,
               discover_fn=discover, context_type=Context) -> dict:
    """在机器级锁内协调各独立组件；一项失败仍继续其余项。"""
    data_dir.mkdir(parents=True, exist_ok=True)
    with FileLock(data_dir / "doctor.lock", timeout=900):
        state = load_json(data_dir / "state.json", default={})
        if not isinstance(state, dict) or state.get("schema_version", 1) != SCHEMA_VERSION:
            raise DbgError("Dbg 状态文件格式不受支持，未覆盖原状态")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        context = context_type(data_dir, state, data_dir / "backups" / stamp)
        # 同版本从源码安装到缓存也必须刷新命令入口，不能在版本快返后继续指向旧目录。
        if os.environ.get("DBG_NODE"):
            from cli_install import install_cli
            cli = install_cli(context, Path(__file__).with_name("launch.cjs"), Path(os.environ["DBG_NODE"]))
            state.setdefault("cli", {}).update(cli)
            context.warnings.extend(cli["warnings"])
            if cli.get("path_hint"):
                context.warnings.append(cli["path_hint"])
            context.save()
        if auto and state.get("auto_completed_version") == PLUGIN_VERSION:
            return {"status": "unchanged", "tools": {}, "warnings": context.warnings}
        # 四个 MCP 与 hook 可能同时首次启动；失败后只抑制自动重复，显式 doctor 始终重试。
        now = datetime.now(timezone.utc)
        attempted = state.get("auto_attempted_at")
        if auto and state.get("auto_attempted_version") == PLUGIN_VERSION and attempted:
            try:
                recent = (now - datetime.fromisoformat(attempted)).total_seconds() < 600
            except (TypeError, ValueError):
                recent = False
            if recent:
                return state.get("last_report", {"status": "failed", "tools": {}, "warnings": ["首次部署尚未完成"]})
        state.setdefault("schema_version", SCHEMA_VERSION)
        tools = state.setdefault("tools", {})
        if not isinstance(tools, dict):
            raise DbgError("Dbg 状态中的 tools 必须是对象")
        config = load_json(data_dir / "config.json", default={})
        if not isinstance(config, dict):
            raise DbgError("Dbg config.json 必须是对象")
        disabled = config.get("disabled", [])
        if not isinstance(disabled, list) or not all(isinstance(x, str) for x in disabled):
            raise DbgError("disabled 必须是工具名称数组")
        installations = discover_fn(config.get("paths", {}))
        state["auto_attempted_version"] = PLUGIN_VERSION
        state["auto_attempted_at"] = now.isoformat()
        context.save()
        results = {}
        entries = recipe_map if recipe_map is not None else recipes()
        if selected and selected not in entries:
            raise DbgError(f"未知工具：{selected}")
        for name, (host_tool, install) in entries.items():
            if selected and name != selected:
                continue
            if name in disabled:
                results[name] = {"status": "disabled"}
                tools[name] = results[name]
                continue
            found = [x for x in installations if x.tool == host_tool]
            if not found:
                results[name] = {"status": "not_installed", "message": "未发现宿主工具，已跳过"}
                tools[name] = results[name]
                continue
            try:
                metadata = install(found, context)
                if not isinstance(metadata, dict):
                    raise DbgError("适配器未返回有效部署结果")
                metadata.setdefault("status", "deployed")
                if metadata["status"] not in ("deployed", "unsupported"):
                    raise DbgError("适配器返回了未知部署状态")
                metadata["checked_at"] = stamp
                metadata["installations"] = [
                    {"root": str(x.root), "version": x.version, "source": x.source}
                    for x in found
                ]
                tools[name] = metadata
                # 终端摘要不回显 runtime 内的认证信息。
                results[name] = {
                    "status": metadata["status"], "version": metadata.get("version", ""),
                    "message": metadata.get("message", "文件与配套运行时已部署"),
                }
            except Exception as exc:
                # 保留上一份运行入口；失败不会伪装成部署成功。
                results[name] = {"status": "failed", "message": str(exc)}
                if name in tools and tools[name].get("runtime"):
                    tools[name]["last_error"] = str(exc)
                else:
                    tools[name] = dict(results[name])
            context.save()
        failed = any(x["status"] == "failed" for x in results.values())
        report = {
            "status": "failed" if failed else "complete", "checked_at": stamp,
            "tools": results, "warnings": context.warnings,
        }
        if not failed and not selected:
            state["auto_completed_version"] = PLUGIN_VERSION
        state["last_report"] = report
        state["plugin_version"] = PLUGIN_VERSION
        context.save()
        atomic_json(data_dir / "last-report.json", report)
        return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="自动检测、更新并修复调试工具扩展及 MCP")
    parser.add_argument("command", choices=["doctor"], nargs="?", default="doctor")
    parser.add_argument("--auto", action="store_true", help="首次加载入口；已成功初始化同版本时快速返回")
    parser.add_argument("--tool", choices=["x64dbg", "ghidra", "windbg", "ida-mcp", "ida-export"])
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = run_doctor(args.data_dir or default_data_dir(), auto=args.auto, selected=args.tool)
    except Exception as exc:
        print(json.dumps({"status": "failed", "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif not (args.auto and result["status"] == "unchanged"):
        for name, entry in result["tools"].items():
            print(f"{name}: {entry['status']} {entry.get('version', '')} {entry.get('message', '')}")
        for warning in result["warnings"]:
            print(f"提示：{warning}")
    return 1 if result["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
