"""One doctor drives first deployment, updates, and repair without model installation decisions."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

from dbg_core import DbgError, FileLock, atomic_json, default_data_dir, load_json
from discovery import discover
from plugin_version import current_version
from runtime import Context
from windbg import backend_mode

PLUGIN_VERSION = current_version()
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
    """Coordinate independent components under a machine-level lock; continue after a component fails."""
    data_dir.mkdir(parents=True, exist_ok=True)
    with FileLock(data_dir / "doctor.lock", timeout=900):
        state = load_json(data_dir / "state.json", default={})
        if not isinstance(state, dict) or state.get("schema_version", 1) != SCHEMA_VERSION:
            raise DbgError("Unsupported Dbg state format; original state was preserved")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        context = context_type(data_dir, state, data_dir / "backups" / stamp)
        config = load_json(data_dir / "config.json", default={})
        if not isinstance(config, dict):
            raise DbgError("Dbg config.json must be an object")
        context.config = config
        windbg_mode = backend_mode(config)
        # Even when the version is unchanged, installing source into a cache must refresh the command entry point before a fast return.
        if os.environ.get("DBG_NODE"):
            from cli_install import install_cli
            cli = install_cli(context, Path(__file__).with_name("launch.cjs"), Path(os.environ["DBG_NODE"]))
            state.setdefault("cli", {}).update(cli)
            context.warnings.extend(cli["warnings"])
            if cli.get("path_hint"):
                context.warnings.append(cli["path_hint"])
            context.save()
        if (auto and state.get("auto_completed_version") == PLUGIN_VERSION
                and state.get("auto_windbg_backend", "auto") == windbg_mode):
            return {"status": "unchanged", "tools": {}, "warnings": context.warnings}
        # Four MCPs and a hook may start together; after failure suppress only automatic retries, while explicit doctor always retries.
        now = datetime.now(timezone.utc)
        attempted = state.get("auto_attempted_at")
        if (auto and state.get("auto_attempted_version") == PLUGIN_VERSION and attempted
                and state.get("auto_windbg_backend", "auto") == windbg_mode):
            try:
                recent = (now - datetime.fromisoformat(attempted)).total_seconds() < 600
            except (TypeError, ValueError):
                recent = False
            if recent:
                return state.get("last_report", {"status": "failed", "tools": {}, "warnings": ["First deployment is incomplete"]})
        state.setdefault("schema_version", SCHEMA_VERSION)
        tools = state.setdefault("tools", {})
        if not isinstance(tools, dict):
            raise DbgError("tools in Dbg state must be an object")
        disabled = config.get("disabled", [])
        if not isinstance(disabled, list) or not all(isinstance(x, str) for x in disabled):
            raise DbgError("disabled must be an array of tool names")
        installations = discover_fn(config.get("paths", {}))
        state["auto_attempted_version"] = PLUGIN_VERSION
        state["auto_attempted_at"] = now.isoformat()
        state["auto_windbg_backend"] = windbg_mode
        context.save()
        results = {}
        entries = recipe_map if recipe_map is not None else recipes()
        if selected and selected not in entries:
            raise DbgError(f"Unknown tool: {selected}")
        for name, (host_tool, install) in entries.items():
            if selected and name != selected:
                continue
            if name in disabled:
                results[name] = {"status": "disabled"}
                tools[name] = results[name]
                continue
            found = [x for x in installations if x.tool == host_tool]
            if not found:
                results[name] = ({"status": "unsupported", "backend_mode": "native",
                                  "message": "Official DbgX.Mcp.Proxy.exe not found; native mode does not fall back."}
                                 if name == "windbg" and windbg_mode == "native" else
                                 {"status": "not_installed", "message": "Host tool not found; skipped"})
                tools[name] = results[name]
                continue
            try:
                metadata = install(found, context)
                if not isinstance(metadata, dict):
                    raise DbgError("Adapter did not return a valid deployment result")
                metadata.setdefault("status", "deployed")
                if metadata["status"] not in ("deployed", "unsupported"):
                    raise DbgError("Adapter returned an unknown deployment status")
                metadata["checked_at"] = stamp
                metadata["installations"] = [
                    {"root": str(x.root), "version": x.version, "source": x.source,
                     **({"backend": x.backend} if getattr(x, "backend", "") else {})}
                    for x in found
                ]
                tools[name] = metadata
                # Terminal summaries do not echo credentials from the runtime.
                results[name] = {
                    "status": metadata["status"], "version": metadata.get("version", ""),
                    "message": metadata.get("message", "Files and supporting runtime deployed"),
                }
                if name == "windbg":
                    results[name].update({key: metadata[key] for key in ("backend", "backend_mode") if key in metadata})
            except Exception as exc:
                # Keep the previous launch entry; failure must not appear as a successful deployment.
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
    parser = argparse.ArgumentParser(description="Automatically detect, update, and repair debugger extensions and MCP servers")
    parser.add_argument("command", choices=["doctor"], nargs="?", default="doctor")
    parser.add_argument("--auto", action="store_true", help="First-load entry point; return quickly if this version initialized successfully")
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
            print(f"Notice: {warning}")
    return 1 if result["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
