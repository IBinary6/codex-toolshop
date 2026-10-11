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

Launching a tool and enabling an extension for the first time may require user action inside that application. Report the specific script status. Do not delete project databases, end user debugging sessions, or modify software licenses as unrelated actions.
