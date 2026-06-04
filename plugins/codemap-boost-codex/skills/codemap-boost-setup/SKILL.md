---
name: codemap-boost-setup
description: Configure or explain CodeMap Boost for Codex, including code-review-graph, graphify, hooks, and AGENTS.md behavior.
---

# CodeMap Boost Setup

Use this skill when the user asks how to configure, verify, or troubleshoot `codemap-boost-codex`.

## Rule

Do not install or register anything from passive hooks. Setup is the explicit opt-in path. Before running install commands, explain that setup may install Python packages and register a Codex MCP server.

## Quick Checks

Run these from the current project when the user wants validation:

```bash
code-review-graph --version
code-review-graph status
```

## Setup

Resolve the plugin root from this skill location, then run the setup script with the user's target project as the working directory. Do not run it from the plugin root unless the plugin repository itself is the target project.

```bash
node <plugin-root>/scripts/setup.cjs
```

The setup script is idempotent:

- If `code-review-graph` already exists, it does not reinstall it.
- If `code-review-graph` is missing, it installs `code-review-graph[all]`.
- It registers MCP with `--no-hooks --no-instructions --no-skills`.
- It writes the Codex enable marker in plugin data so hooks may build/update graphs.

Optional graphify support is enabled only when explicitly requested:

```bash
node <plugin-root>/scripts/setup.cjs --with-graphify
```

Underlying dependency commands:

```bash
python -m pip install "code-review-graph[all]"
code-review-graph install --platform codex --no-hooks --no-instructions --no-skills --yes
python -m pip install "graphifyy[all]"
```

## Codex Behavior

- Global guidance is managed in `$CODEX_HOME/AGENTS.md`.
- Project graph output is `.code-review-graph/`.
- Optional graphify output is `graphify-out/`.
- Hooks stay silent until setup writes the enable marker.
- The plugin owns Codex hooks; do not let `code-review-graph install` add third-party hooks.
- The plugin should not read or write old host directories.
- Use code-review-graph MCP tools for symbols, callers, callees, references, impact analysis, and review context.
