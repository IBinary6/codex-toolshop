---
name: codemap-boost-setup
description: Configure or explain CodeMap Boost for Codex, including code-review-graph, graphify, hooks, and AGENTS.md behavior.
---

# CodeMap Boost Setup

Use this skill when the user asks how to configure, verify, or troubleshoot `codemap-boost-codex`.

## Quick Checks

Run these from the current project when the user wants validation:

```bash
code-review-graph --version
code-review-graph install --platform codex --no-hooks --no-instructions --no-skills --yes
code-review-graph status
```

Optional graphify support:

```bash
graphify --version
```

If `graphify` is missing, install the PyPI package named `graphifyy`:

```bash
python -m pip install "graphifyy[all]"
```

## Codex Behavior

- Global guidance is managed in `$CODEX_HOME/AGENTS.md`.
- Project graph output is `.code-review-graph/`.
- Optional graphify output is `graphify-out/`.
- The plugin owns Codex hooks; do not let `code-review-graph install` add third-party hooks.
- The plugin should not read or write old host directories.
- Use code-review-graph MCP tools for symbols, callers, callees, references, impact analysis, and review context.
