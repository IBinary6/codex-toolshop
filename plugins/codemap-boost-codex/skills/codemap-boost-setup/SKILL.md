---
name: codemap-boost-setup
description: Configure, verify, or troubleshoot CodeMap Boost, including bundled graph and Serena MCPs, private runtimes, project activation, dashboard suppression, hooks, and legacy MCP migration.
---

# CodeMap Boost Setup

## Default behavior

Treat plugin installation as the complete normal setup. The bundled `.mcp.json` exposes `code-review-graph` while a cross-platform Node launcher creates or repairs the isolated CRG venv before serving MCP. It uses the marketplace-qualified Codex plugin data directory, serializes concurrent installation, and declares a 600-second startup timeout. Node.js 18 or newer must be resolvable as `node` by the Codex host itself; never assume that a desktop app inherits Homebrew, nvm, or an interactive shell PATH. Do not ask the user to run setup after a normal installation.

The same manifest also exposes `serena` through `scripts/serena-server.cjs`. Its launcher uses `serena-agent==1.7.0` as the initial compatibility baseline in a separate versioned venv and sets a private `SERENA_HOME`. Weekly background checks can select newer stable versions after validation. Every launch explicitly disables the web dashboard, browser auto-open, and GUI log window. It starts without an active project because MCP `cwd` is the plugin directory. Before using semantic tools, activate the actual target project's absolute root through `activate_project`; confirm the active project when switching targets. Existing project `.serena` settings still apply; global isolation does not replace project configuration.

CRG and Serena automatically check official PyPI stable versions at most once every seven days of use. Candidate environments are independent; failed validation retains the current version, while successful candidates are used on later launches. For versions, check history, or immediate updates, use `codemap-upgrade-runtime`. The installed plugin also schedules a weekly native Codex update for its official codex-toolshop marketplace; source development copies do not. `scripts/plugin-update.cjs --doctor` reports that separate process. Source refresh does not restart an existing task or prove runtime compatibility.

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

For implementation, function, class, caller, dependency or impact discovery, query the graph first and read source at the returned paths and lines. Use available Serena/LSP tools when precise definitions, implementations or references are needed. If the graph has no match, is unavailable or lacks coverage, continue with semantic tools or text search to locate candidates. Feed candidate symbols or paths into the graph or Serena when further relationships need confirmation; stop when the evidence is sufficient. After capability discovery confirms absence, inspect source and check whether the task predates installation.

For Serena, discover the actual exposed tool schema, activate the correct project, then select `find_symbol`, `get_symbols_overview`, `find_referencing_symbols`, or another relevant semantic tool. Serena source coordinates can be zero-based; convert only according to the returned schema when presenting file links. A language server's scope and build configuration limit its answers: C/C++ cross-file analysis commonly needs `compile_commands.json` and clangd. Package installation alone does not prove language-server readiness. Use source/text fallback if activation or LSP startup fails. Symbol editing follows the user's existing edit authorization and normal verification requirements.

If an existing MCP manager also provides Serena (for example under another server name), use one verified instance for the target project. Plugin installation does not disable, rewrite, or remove that manager's Codex or Claude configuration. Avoid duplicate project activation across both instances for the same lookup.

Known files do not require a graph query. Literal text, logs, configuration keys and filename enumeration can use text tools directly. Prefer the installed and ready `tgrep-search-codex` wrapper, whose own hook supplies the absolute command (`node <plugin>/scripts/tgrep.cjs search [--fresh] <args>`). When that wrapper is missing, its index is incomplete or unhealthy, the scope does not fit, or immediate content is required, use a live `rg` scan or `tgrep --no-index`. A zero result is not evidence that content does not exist. Check final completeness and files just changed with live source reads or scans. Use `tgrep --files` for healthy indexed discovery and `rg --files` for a live file list. Higher-level host rules take precedence.

## Doctor fallback

When the user asks for diagnosis, run the read-only doctor from the target project:

```bash
node <plugin-root>/scripts/setup.cjs --doctor
```

Resolve `<plugin-root>` from this skill location or from `codex plugin list --json`. Doctor reports the active Node.js version and `>=18.0.0` requirement, effective Codex paths, marketplace-qualified plugin data directory, private runtime/parser health, bundled MCP timeout, same-name global overrides, project graph status, and restart guidance. A CRG status timeout or temporarily unavailable state is reported as a retryable status, not as `NEEDS_BUILD`; a missing graph directory or explicit status failure remains a build-needed state. If no executable standalone Codex CLI is available, the CLI-dependent checks are `UNKNOWN`/`WARN` rather than a plugin failure. Exit `0` means `READY`; exit `1` means attention is required. Never combine `--doctor` with setup flags.

For Serena runtime diagnosis, run `node <plugin-root>/scripts/serena-server.cjs --doctor`. This is a read-only runtime/configuration check, not proof of a live MCP handshake or LSP lookup. `codex mcp get serena --json` should resolve to the plugin's Node launcher and 600-second startup timeout. To verify the complete integration, run the plugin's `npm run test:serena-smoke`: it prepares an isolated runtime, performs the MCP handshake, activates a temporary TypeScript project, and checks a known symbol with dashboard/browser/GUI disabled. Normal use does not require running this test.

## Setup fallback

Run setup only for repair, explicit prewarming, initial graph build, or legacy registration migration:

```bash
node <plugin-root>/scripts/setup.cjs --build
```

Run it with the user's target Git repository as the working directory. It is idempotent and:

- maintains the selected private CRG runtime (`crg-runtime` initially, then validated `crg-runtimes/<version>` candidates) without modifying PATH or user site-packages;
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

- Activate graph refresh and graph-first reminders only when Git resolves the target directory or a parent to a working tree. Use `git rev-parse --show-toplevel`, not a `.git` directory-only test: linked worktrees have a `.git` file. Resolve a nested directory to its own worktree root and keep `.code-review-graph/` there, separate from the main checkout and other worktrees. Non-Git directories use source/text inspection; project graph calls are rejected before creating a graph. Repository-registry queries retain their separate global scope.
- Keep global guidance in `$CODEX_HOME/AGENTS.md`.
- Keep project graph output in `.code-review-graph/` and optional graphify output in `graphify-out/`.
- Let SessionStart maintain the graph synchronously and PostToolUse coalesce refreshes in the background; let the graph MCP PreToolUse barrier perform the final synchronous freshness check.
- Refreshes use the plugin's `scripts/refresh_graph.py` with the private runtime. It checks CRG errors, post-processing warnings, source stability and graph file hashes before committing verified metadata. A commit made after its source was already indexed advances provenance without re-parsing the graph; the original parse time remains unchanged. The first upgrade from an unverified graph performs one full build. A failed refresh clears provenance and the success marker; a later read retries the repair instead of claiming freshness.
- Untracked, non-ignored files enter a temporary Git index so CRG chooses supported file types itself. The user's real Git index is preserved. A same-SHA branch switch still refreshes branch metadata. Actual content mismatches, including a restored uncommitted file, can require a full repair; ordinary no-change reads reuse the verified marker.
- The managed AGENTS block and entry-point injection share one three-point rule set; this section retains the implementation details for graph retrieval, tgrep routing, and hook behavior on demand. CodeMap does not install or start tgrep, and it does not add a tgrep reminder hook.
- The Bash hook also covers Codex exec_command and Code Mode inner exec_command calls. It filters common searches and emits only a short conditional reminder once per user turn; each UserPromptSubmit resets it, even within the same turn. Parallel searches claim an empty hash-named marker atomically in plugin data. Missing IDs or unavailable storage fall back to a stateless hint. It never denies, rewrites commands, refreshes graphs, or stores prompts and commands.
- Let SubagentStart inject retrieval rules without rebuilding the graph.
- Let routing plugins choose the worker while CodeMap Boost owns graph freshness and retrieval policy.
- Do not let `code-review-graph install` add third-party hooks, instructions, or skills.
- Managed AGENTS updates preserve surrounding text and reject incomplete, reversed or duplicate block markers. If another application manages AGENTS, synchronize its authoritative source after an authorized update; this plugin does not edit another application's database.
