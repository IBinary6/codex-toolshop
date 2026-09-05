---
name: codemap-boost-setup
description: Configure, verify, or troubleshoot CodeMap Boost for Codex, including the bundled code-review-graph MCP, private runtime, legacy MCP migration, graphify, hooks, and AGENTS.md behavior.
---

# CodeMap Boost Setup

## Default behavior

Treat plugin installation as the complete normal setup. The bundled `.mcp.json` exposes `code-review-graph` while a cross-platform Node launcher creates or repairs the isolated CRG venv before serving MCP. It uses the marketplace-qualified Codex plugin data directory, serializes concurrent installation, and declares a 600-second startup timeout. Node.js 18 or newer must be resolvable as `node` by the Codex host itself; never assume that a desktop app inherits Homebrew, nvm, or an interactive shell PATH. Do not ask the user to run setup after a normal installation.

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
- `startup_timeout_sec` equal to `600`.

The plugin-root `cwd` is only for locating the launcher. The graph `PreToolUse` hook injects the active task's Git root as `repo_root` for CRG project tools, while preserving an explicit `repo_root` and leaving cross-repository registry tools unchanged.

MCP tools may be deferred and absent from static or top-level schemas. If `mcp__code_review_graph__` is not visible in the current top-level list, do not treat that alone as proof of absence: before claiming the MCP is unavailable, inspect `ALL_TOOLS` for `mcp__code_review_graph__*` when available or make an appropriate graph-tool call. Only after that check report the MCP as unavailable and use a fallback; never claim a graph query ran without evidence.

After capability discovery confirms absence, use available source inspection and check whether the task predates installation. Known files and literal searches do not require a graph query.

## Doctor fallback

When the user asks for diagnosis, run the read-only doctor from the target project:

```bash
node <plugin-root>/scripts/setup.cjs --doctor
```

Resolve `<plugin-root>` from this skill location or from `codex plugin list --json`. Doctor reports the active Node.js version and `>=18.0.0` requirement, effective Codex paths, marketplace-qualified plugin data directory, private runtime/parser health, bundled MCP timeout, same-name global overrides, project graph status, and restart guidance. A CRG status timeout or temporarily unavailable state is reported as a retryable status, not as `NEEDS_BUILD`; a missing graph directory or explicit status failure remains a build-needed state. If no executable standalone Codex CLI is available, the CLI-dependent checks are `UNKNOWN`/`WARN` rather than a plugin failure. Exit `0` means `READY`; exit `1` means attention is required. Never combine `--doctor` with setup flags.

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
- Let SessionStart maintain the graph synchronously and PostToolUse coalesce refreshes in the background; let the graph MCP PreToolUse barrier perform the final synchronous freshness check.
- Preserve graph-first reminders at session, structural-prompt and subagent boundaries. For structural questions, query available graph tools first and then verify source; known-file reads and literal text searches remain direct.
- The Bash hook also covers Codex exec_command and Code Mode inner exec_command calls. It filters common searches and emits only a short conditional reminder once per user turn; each UserPromptSubmit resets it, even within the same turn. Parallel searches claim an empty hash-named marker atomically in plugin data. Missing IDs or unavailable storage fall back to a stateless hint. It never denies, rewrites commands, refreshes graphs, or stores prompts and commands.
- Let SubagentStart inject retrieval rules without rebuilding the graph.
- Let routing plugins choose the worker while CodeMap Boost owns graph freshness and retrieval policy.
- Do not let `code-review-graph install` add third-party hooks, instructions, or skills.
- Managed AGENTS updates preserve surrounding text and reject incomplete, reversed or duplicate block markers. If another application manages AGENTS, synchronize its authoritative source after an authorized update; this plugin does not edit another application's database.
