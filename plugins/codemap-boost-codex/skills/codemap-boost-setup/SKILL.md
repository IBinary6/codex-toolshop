---
name: codemap-boost-setup
description: Configure or explain CodeMap Boost for Codex, including code-review-graph, graphify, hooks, and AGENTS.md behavior.
---

# CodeMap Boost Setup

Use this skill when the user asks how to configure, verify, or troubleshoot `codemap-boost-codex`.

## Rule

CodeMap Boost is auto-enabled for Codex. The standard AI installation flow checks `codex` CLI and prefers `uv` (falling back to Python `venv`), installs the plugin, then immediately runs setup in the user's target repository. Setup owns an isolated CRG venv under plugin data, probes parsers with Python isolated mode, and registers MCP to that absolute runtime path. SessionStart remains a fallback for missed setup, broken user-site installs, old MCP config, or a fixed `cwd`. Structural prompts and source-changing tools maintain the graph; SubagentStart only injects retrieval guidance, while the graph MCP PreToolUse barrier performs the final synchronous freshness check.

## Quick Checks

Run these from the current project when the user wants validation:

```bash
<managed-runtime-reported-by-setup> --version
<managed-runtime-reported-by-setup> status
codex mcp get code-review-graph --json
```

## Setup

Resolve the plugin root from this skill location. If the skill is not loaded in the current task, run `codex plugin list --json`, find `codemap-boost-codex@codex-toolshop`, and use its `source.path`. Run the setup script with the user's target project as the working directory. The installing AI should do this immediately after plugin installation; do not make the user remember it. Do not run it from the plugin root unless the plugin repository itself is the target project.

```bash
node <plugin-root>/scripts/setup.cjs --build
```

The setup script is idempotent:

- It ignores unrelated global/user-site CRG commands and owns `<plugin-data>/crg-runtime` without changing PATH.
- It prefers `uv venv --python 3.12`, falling back to Python `venv`, then installs `code-review-graph[all]` only inside that venv.
- It verifies the managed CLI and loads Python, JavaScript, TypeScript, and TSX parsers using `python -I`, matching CRG's own isolated parser probe.
- It checks `codex mcp get code-review-graph --json`; missing, disabled, wrong command/args, uvx/global command, or fixed `cwd` are repaired to the managed absolute path with `codex mcp remove` and `codex mcp add`.
- It writes a diagnostic marker and exits non-zero on registration failure; the message includes a copy-pasteable command and says to open a new task after repair.
- It updates the target project's `.gitignore` for graph output directories when run explicitly.
- Hooks synchronously build/update graphs when `code-review-graph` is available; SessionStart attempts to make it available automatically. PostToolUse skips known read-only Bash commands.

Optional graphify support is enabled only when explicitly requested:

```bash
node <plugin-root>/scripts/setup.cjs --with-graphify
```

Equivalent internal commands for troubleshooting only; never repair this with `pip install --user`:

```bash
uv venv --python 3.12 "<plugin-data>/crg-runtime"
uv pip install --python "<plugin-data>/crg-runtime/<python>" --upgrade "code-review-graph[all]"
# 没有 uv 时：
python -m venv "<plugin-data>/crg-runtime"
"<plugin-data>/crg-runtime/<python>" -m pip install --upgrade "code-review-graph[all]"
python -m pip install "graphifyy[all]"
```

完成 setup 后验证版本、状态和 MCP JSON；修复或首次注册 MCP 后必须新开 Codex 任务，因为已启动任务不会动态注入新的 MCP。

## Codex Behavior

- Global guidance is managed in `$CODEX_HOME/AGENTS.md`.
- Project graph output is `.code-review-graph/`.
- Optional graphify output is `graphify-out/`.
- SessionStart writes graph output paths to `.git/info/exclude` so passive hooks do not dirty tracked project files.
- Hooks stay silent when graph behavior is explicitly disabled.
- The plugin owns Codex hooks; do not let `code-review-graph install` add third-party hooks.
- The plugin should not read or write old host directories.
- Use code-review-graph MCP tools for symbols, callers, callees, references, impact analysis, and review context.
- Routing plugins such as Agent Dispatch choose the worker; CodeMap Boost owns graph refresh and retrieval policy. Do not start a duplicate build/update from a subagent unless a hook reports failure or the user explicitly requests a rebuild.
