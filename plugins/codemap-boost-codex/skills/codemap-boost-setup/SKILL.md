---
name: codemap-boost-setup
description: Configure, verify, or troubleshoot CodeMap Boost for Codex, including the bundled code-review-graph MCP, private runtime, legacy MCP migration, graphify, hooks, and AGENTS.md behavior.
---

# CodeMap Boost Setup

## Default behavior

Treat plugin installation as the complete normal setup. The bundled `.mcp.json` exposes `code-review-graph` while a cross-platform Node launcher creates or repairs the isolated CRG venv before serving MCP. It uses the marketplace-qualified Codex plugin data directory, serializes concurrent installation, and declares a 100-second startup timeout. Do not ask the user to run setup after a normal installation.

After installing or upgrading the plugin, ask the user to create a new Codex task because an already-running task cannot dynamically add MCP tools. On upgrades, SessionStart probes Codex CLI candidates instead of trusting the first PATH entry, then removes an old absolute-path registration only when its plugin-data path proves plugin ownership; if that migration occurred, create one more new task. A missing standalone CLI prevents the legacy override check, although the bundled MCP launcher itself does not depend on that CLI. Never auto-remove `uvx code-review-graph serve`, because the command alone cannot prove whether the plugin or the user created it. Doctor should report that ambiguous override for user confirmation.

## Verification

Use this command for a low-level MCP check:

```bash
codex mcp get code-review-graph --json
```

The bundled configuration should resolve to:

- stdio command `node`;
- argument `scripts/mcp-server.cjs`;
- `cwd` resolved under the installed plugin root;
- `startup_timeout_sec` equal to `100`.

The plugin-root `cwd` is only for locating the launcher. The graph `PreToolUse` hook injects the active task's Git root as `repo_root` for CRG project tools, while preserving an explicit `repo_root` and leaving cross-repository registry tools unchanged.

If `mcp__code_review_graph__` is absent from the current task, state that the task did not load the MCP and use a suitable fallback. Never claim a graph query ran. Check whether the task predates installation before diagnosing the plugin.

## Doctor fallback

When the user asks for diagnosis, run the read-only doctor from the target project:

```bash
node <plugin-root>/scripts/setup.cjs --doctor
```

Resolve `<plugin-root>` from this skill location or from `codex plugin list --json`. Doctor reports the effective Codex paths, marketplace-qualified plugin data directory, private runtime/parser health, bundled MCP timeout, same-name global overrides, project graph status, and restart guidance. If no executable standalone Codex CLI is available, the CLI-dependent checks are `UNKNOWN`/`WARN` rather than a plugin failure. Exit `0` means `READY`; exit `1` means attention is required. Never combine `--doctor` with setup flags.

## Setup fallback

Run setup only for repair, explicit prewarming, initial graph build, or legacy registration migration:

```bash
node <plugin-root>/scripts/setup.cjs --build
```

Run it with the user's target Git repository as the working directory. It is idempotent and:

- maintains `<plugin-data>/crg-runtime` without modifying PATH or user site-packages;
- prefers `uv` with Python 3.12, then falls back to Python `venv`;
- verifies the CLI and Python, JavaScript, TypeScript, and TSX parsers in isolated mode;
- removes only old plugin-managed same-name global MCP registrations and preserves unrelated user-managed paths;
- updates the target project's `.gitignore` and optionally starts the initial graph build.

Enable optional graphify only when requested:

```bash
node <plugin-root>/scripts/setup.cjs --with-graphify
```

Never repair CRG with `pip install --user`.

## Codex behavior

- Keep global guidance in `$CODEX_HOME/AGENTS.md`.
- Keep project graph output in `.code-review-graph/` and optional graphify output in `graphify-out/`.
- Let SessionStart and PostToolUse maintain the graph; let the graph MCP PreToolUse barrier perform the final synchronous freshness check.
- Let SubagentStart inject retrieval rules without rebuilding the graph.
- Let routing plugins choose the worker while CodeMap Boost owns graph freshness and retrieval policy.
- Do not let `code-review-graph install` add third-party hooks, instructions, or skills.
