---
name: dbg-doctor
description: Use when the user asks to install, detect, update, or repair debugger extensions and their MCP servers, or explicitly requests Dbg doctor. One script handles all deployment.
---

# Dbg doctor

Dbg scripts already implement installation, directory discovery, updates, and repair. Do not replan deployment and copy plugins by hand, or write MCP configuration for CC Switch or another client.

When the user requests doctor, run this one command from the plugin directory:

```text
node <plugin-root>/scripts/launch.cjs doctor
```

The script changes extensions for discovered tools and Dbg's own runtime. First installation and later runs use the same workflow. It backs up managed files and protects other plugins. If the user specifies one tool, pass `--tool x64dbg|ghidra|windbg|ida-mcp|ida-export`.

Pass `--json` for machine-readable output. Exit code 0 means this deployment check completed; exit code 1 means failures remain. An undiscovered tool is skipped, not considered installed. Distinguish file deployment, MCP handshake, and a live connection inside the debugger. A status service for a missing tool does not provide debugging capability.

Explicit paths may be set in the `paths` object of `config.json` in the Dbg data directory, such as `{"paths":{"ida":["D:/Tools/IDA 9.0"]}}`. Use this only when the user supplied a path or automatic discovery is insufficient; do not require every user to configure paths in advance.

For WinDbg, `windbg.backend` in that same configuration accepts `auto` (default), `native`, or `legacy`. Native uses the installed official `DbgX.Mcp.Proxy.exe`; `paths.windbg` accepts its executable or directory. Auto prefers native and retains an existing usable legacy runtime without downloading a backup. It falls back only when the native executable is missing or its process cannot be created. A successfully created proxy's exit, missing or occupied sessions, and secure/sampling failures require diagnosis, not automatic backend switching. Explicit native never falls back. Run `doctor --tool windbg` after changing the selection.

Native deployment is metadata only. To connect, the user starts MCP Service in the intended WinDbg window, retaining default secure mode. Use `list_sessions`, `connect_session`, and `disconnect_session` to select the intended session; verify its target and state. Codex compatibility is best-effort, and protected operations may require MCP sampling. Report those limits without changing security settings or disconnecting another client. See the plugin README's WinDbg section for official setup links.

Launching a tool and enabling an extension for the first time may require user action inside that application. Report the specific script status. Do not delete project databases, end user debugging sessions, or modify software licenses as unrelated actions.
