# CodeMap Boost for Codex

`codemap-boost-codex` bundles two native MCP services: `code-review-graph` (CRG) for code structure and impact, and Serena for language-server definitions, implementations, and references. It does not read or modify legacy host directories. Persistent Codex guidance lives in `$CODEX_HOME/AGENTS.md`; runtime data lives in the Codex plugin data directory.

## Relationship to the Claude Code version

Both versions prefer graph evidence for structural questions and require a successful refresh before graph reads. Since 0.1.36, the Codex version defers heavy runtime preparation and refresh until actual use.

| Capability | Codex version | Claude Code version |
| --- | --- | --- |
| Session start | Lightweight Node MCP discovery; `SessionStart` maintains guidance and compatibility configuration | Background build/update after `SessionStart`, with setup advice if the CLI is missing |
| Refresh after edits | Deferred until the next graph read, based on source and database fingerprints | Background refresh after `PostToolUse` or `CwdChanged` |
| Read barrier | Graph MCP `PreToolUse` refreshes synchronously and denies the read on failure | Same synchronous barrier |
| Retrieval guidance | One shared rule set in managed AGENTS, SessionStart, structural prompts, and subagent entry points, including lightweight guidance outside Git | Strong graph-first hints on `Grep` and `Agent` |
| Dependency installation | Prepares a versioned private runtime on first actual use | Explicit `/codemap-boost-setup` confirmation |

The managed AGENTS block and hook entry points share three rules: tool and target selection, text-search fallback, and evidence/freshness. Details on verifying graph tools and text fallback are in the [setup skill](skills/codemap-boost-setup/SKILL.md#verification).

1. Discover CRG and Serena independently in the current tool catalog and deferred discovery facility. Pass the actual target Git worktree as CRG `repo_root`; activate the target project's absolute path in Serena. Neither task cwd nor MCP launcher cwd substitutes for the target root.
2. Read known files directly. For literal text and filename enumeration, verify the actual `tgrep-search-codex` CLI and run it from the target directory; use live `rg` when it is not ready. An unavailable tool is a current observation: fall back immediately and rediscover on later natural demand without busy-waiting or permanent negative caching.
3. Use CRG for relationships and impact, Serena/LSP for precise symbols, and tgrep/rg for text. Add only evidence the question still needs and stop when it is sufficient.

## Bundled Serena and project boundaries

Since 0.1.31, the native MCP prepares Serena automatically. Its initial compatibility baseline is `serena-agent==1.7.0`, with weekly update checks. Serena and CRG have separate private venvs. Stable user settings live under `<plugin-data>/serena-home`; each MCP connection receives private session configuration while reusing stable language-server executables and versioned runtimes.

Every launch explicitly uses `start-mcp-server --context codex` with `--enable-web-dashboard false`, `--open-web-dashboard false`, and `--enable-gui-log-window false`. These respectively disable the dashboard service, browser opening, and GUI log window. A stray trailing `false` is parsed upstream as a project name, so it cannot disable the UI. See the [official CLI arguments](https://github.com/oraios/serena/blob/v1.7.0/src/serena/cli.py).

The MCP cwd locates plugin scripts. The launcher does not use `--project-from-cwd` or activate the plugin repository as a user project. Before semantic queries, call Serena `activate_project` with the actual target's absolute root, and confirm it again after switching projects. Existing `.serena/project.yml` settings still apply. The plugin does not rewrite project settings, CC Switch, or another manager's Serena registration. If another Serena instance exists, select one verified instance for the lookup; the user manages whether to disable an older instance.

The wrapper supports Windows, macOS, and Linux. Serena 1.7.0 requires Python 3.11–3.14. Package installation and a working language server are separate checks. First activation may download dependencies; C/C++ commonly needs clangd and `compile_commands.json` for cross-file analysis. See [official language support](https://oraios.github.io/serena/01-about/020_programming-languages.html). When a language server is unavailable, use graph, source, and text evidence.

Since 0.1.39, the Serena frontend prepares C/C++ compilation parameters before activation or semantic reads. It prefers a valid root `compile_commands.json`, then an explicitly selected database or the only valid database under `build/`. Relative directories are normalized in a private copy. For a Windows `.vcxproj` without a database, the MSBuild Evaluation API extracts the selected configuration, toolset, SDK, per-file macros, includes, forced includes, and language standard. It evaluates without running builds, targets, tasks, or custom build actions. Release and host architecture are preferred by default. Generated data stays under `<plugin-data>/serena-build/<project-id>/<generation>/`; project source, build settings, and system clangd settings remain untouched.

Database preparation is shared across platforms; MSBuild is a Windows-only adapter. On macOS/Linux, use an existing build-system database or select a database directory in private configuration. Missing metadata produces an explicit limitation rather than a guessed toolchain. Multiple projects or databases can be disambiguated in `<plugin-data>/serena-build/<project-id>/config.json` using `project`, `configuration`, `platform`, or `databaseDir`, with paths relative to the real project root. A valid root database still wins. Missing tools, flags that cannot be converted reliably, or user C++ language-server settings that take control are reported as limitations, without claiming complete references. Other languages retain native Serena configuration.

When build configuration, imports, or a compilation database changes, the frontend drains native requests and callbacks, stops its owned backend, and restores the active project with new parameters. The cache tracks optional import existence and wildcard membership; editing an existing source file alone does not invalidate build inputs. Dynamic expressions that cannot be tracked cause conservative reevaluation. The parameter generation participates in the language-server cache identity so changed macros cannot reuse stale symbols. Preparation success alone does not prove that a real symbol query passed.

Since 0.1.40, POSIX shutdown first sends stdin EOF and waits a bounded period for normal exit, then checks the current user's process tree using a random environment marker unique to each backend. It rechecks marker, user, PID, and process creation time before fallback signals. If identity cannot be read, permissions fail, or descendants remain, shutdown fails and the session stays in place instead of starting a second backend. Windows retains live `ChildProcess` and `taskkill /T` safeguards. The marker guarantee does not cover custom wrappers that deliberately remove inherited environment variables.

Managed clangd defaults to two asynchronous workers (`-j=2`) with background indexing. An explicit `-j` in stable private `serena-home/serena_config.yml` takes precedence. This controls parsing concurrency, not the number of reference results. Effective arguments enter the private cache identity. Runtime promotion also tests the frontend's real clone/resolve/apply configuration path.

`npm run test:serena-smoke` uses real TypeScript and C++ services to check project switching, compilation-parameter refresh, symbol references, and backend exit. On POSIX, it also scans for late descendants with the old backend marker. `npm test` includes a POSIX process-cleanup regression requiring Python and `psutil==7.0.0`; `CODEMAP_SERENA_TEST_PYTHON` can point to Serena's private Python. Windows reports that POSIX-only check as inapplicable, while native smoke tests are configured in CI for all three operating systems. CI configuration is not evidence of a completed platform run; inspect actual results for release acceptance.

For read-only runtime diagnosis, use `node "<plugin-root>/scripts/serena-server.cjs" --doctor`. The complete `npm run test:serena-smoke` check includes isolated installation, MCP handshake, UI-disabled startup, temporary project activation, and a real symbol query. Normal use requires neither command.

## Weekly updates

Tool runtimes and plugin source update separately:

- **CRG and Serena:** CRG schedules its update check after actual use; starting Serena schedules only Serena's check. Checks occur at most once every seven days of use and share installation locks. Candidates install in independent version directories. CRG must pass parser, refresh-adapter, and real MCP metadata-export checks; Serena must pass MCP/CLI and UI-disabled checks. Only then does a version pointer change for later launches.
- **tgrep:** The separate `tgrep-search-codex` plugin owns official GitHub release checks, asset validation, and search-service verification. CodeMap does not duplicate them.
- **Plugin source:** An installed copy from the official `codex-toolshop` Git marketplace can schedule a weekly native Codex marketplace refresh after graph access. It checks cache versions for already installed, enabled plugins from that marketplace without installing or enabling others. Source development copies do not trigger user-plugin upgrades.

Updates never replace an active venv or remove the old version. Network, installation, or compatibility failures retain the old runtime and record a timestamp and error. Existing MCP processes do not restart mid-task; source updates require a later new task. If the Codex CLI is missing, a cache is locked, or native update fails, diagnostics retain the current cache without killing processes or deleting locked directories.

After locating its script, each persistent launcher changes to the plugin data directory, including its child process, so Windows can replace plugin-cache directories later. This cwd is not the target project; graph calls still need the real `repo_root`, and Serena still needs target activation. Older running processes retain their original cwd until exit. If an old process holds a cache, finish the task and restart Codex normally.

These are use-triggered checks, not jobs running while the computer is off. No version change means no reinstall. Inspect or request an immediate check with:

```bash
node scripts/runtime-update.cjs --doctor
node scripts/runtime-update.cjs --check-now
node scripts/plugin-update.cjs --doctor
node scripts/plugin-update.cjs --check-now
```

`--doctor` is read-only; `--check-now` performs a check. `CODEMAP_BOOST_DISABLE_RUNTIME_UPDATES=1` disables automatic runtime updates, and `CODEX_TOOLSHOP_DISABLE_PLUGIN_UPDATES=1` disables automatic plugin-source refresh. Neither prevents initial preparation of a missing baseline runtime.

## Install and use

The Codex desktop host must resolve `node` from its own PATH; an interactive terminal PATH is not proof. Node.js 18 or newer and Git are required. A standalone `codex` CLI is optional for old global-MCP migration and some doctor checks, not for the native launcher. `uv` is preferred to create a private Python 3.12 venv; without it, the plugin tries Python with `venv` in order: 3.12, 3.11, then current Python. Users need not preinstall CRG or Serena or run setup after normal installation.

```bash
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
codex plugin add codemap-boost-codex@codex-toolshop
```

Open a new Codex task. The bundled `.mcp.json` starts two cross-platform Node entry points. CRG immediately offers tool and prompt-template discovery, preparing Python only on an actual backend request. Serena prepares its own isolated venv and stdio server. Discovery does not depend on post-start `SessionStart` registration; the primary agent and auto-spawned subagents can discover tools in that new task.

Native MCP configuration sets `startup_timeout_sec = 600`, plus `tool_timeout_sec = 600` for CRG cold calls. Runtime preparation and the pre-read refresh barrier each use a shared absolute 570-second budget; lock wait, venv creation, installation, and health probes consume only remaining time. An installation command is capped at five minutes and a lock wait at nine minutes. Installation locks serialize concurrent tasks targeting the same venv.

### CRG on-demand backend

`initialize`, `ping`, and tool, prompt-template, and resource lists are served by a lightweight Node frontend without starting `serve` or a semantic model. The bundled discovery snapshot comes from real CRG 2.3.9; first use without a runtime installs that exact version. Existing versions use matching cached metadata, while an unknown version gets a brief metadata-only Python export that explicitly forbids Torch, Transformers, and SentenceTransformer imports. Candidate updates export and validate discovery metadata before promotion. A connection freezes its runtime choice so discovery and execution use the same version.

The first request needing the backend starts the original `code-review-graph serve`. On Windows, it retains upstream main-thread model prewarming to avoid known first-load Torch/DLL/OpenMP hangs on worker threads. This initialization cost applies to the first ordinary structural query; the graph and semantic-model phases are not split. Since 0.1.37, ten minutes after the last backend work, the frontend recycles only its heavy process tree while retaining discovery and the disk graph. Preparation, startup, active requests, callbacks, and forwarded cancellation awaiting a response block retirement. Discovery and ping do not extend the timer. A request during retirement waits for confirmed exit and shares one restart; initialization and logging state are replayed. Connection close, stdin EOF, or termination also cleans up the owned process tree.

`SessionStart` does not probe, install, build, or refresh CRG, and edits trigger no hook at all. The actual graph-read barrier validates the real Git worktree, prepares the runtime, and refreshes the index. Untracked source enters a temporary Git index while the user's real index remains untouched. Each linked worktree has its own graph.

For a real-function and Windows-memory comparison, run `npm run test:crg-smoke -- --data-dir <private-data-dir> --output <report.json>`. It checks lightweight discovery, the first graph query, Windows model loading, five prompt templates, edits and untracked source, worktree isolation, vector search, concurrent reuse, and EOF cleanup in temporary repositories. `--plugin-root <old-plugin> --baseline --discovery-only` measures an older startup baseline. Working-set reports include shared pages and are not a net physical-memory saving.

For idle retirement, run `npm run test:crg-idle -- --data-dir <private-data-dir> --output <report.json>`. It waits the full ten minutes by default, then verifies graph and vector queries, concurrent recovery, EOF cleanup, working set, and Private Bytes for the same process tree. `--plugin-root <installed-plugin>` targets an installed copy. `--idle-ms 5000` accelerates an explicit smoke check only; it does not change or replace the production ten-minute acceptance check.

Verify Codex's resolved native MCP with `codex mcp get code-review-graph --json`. Expect stdio `node`, `scripts/mcp-server.cjs`, an installed-plugin-root cwd, and `startup_timeout_sec = 600`. That cwd only locates the launcher. Before project graph calls, `PreToolUse` supplies the current task's Git root as `repo_root` unless one was explicitly supplied. After installation or upgrade, a new task reliably loads the tools. In a current task where availability is unconfirmed, use a fallback and rediscover on later natural demand. MCP tools may be deferred and absent from static or top-level schemas; inspect `ALL_TOOLS` for `mcp__code_review_graph__*` or make one relevant call before declaring them unavailable. Never claim a graph query ran without evidence.

## Automatic activation and migration

The native MCP launcher is the normal installation path. It uses the same marketplace-qualified plugin data directory as hooks and prepares the runtime on first real use. `SessionStart` manages the `$CODEX_HOME/AGENTS.md` block and old plugin-created global MCP overrides; project build/update waits for the read barrier.

An old absolute-path global registration in `config.toml` may shadow the native MCP. `SessionStart` probes executable Codex CLI candidates rather than trusting the first PATH entry, proves plugin ownership from the plugin-data path, and removes only that owned override. If migration occurred, open one more new task. Without a standalone CLI, this optional old-override check is unavailable, though the bundled launcher still works. A legacy `uvx code-review-graph serve` command does not prove ownership, so it is never removed automatically; doctor reports it for user confirmation.

## Setup and doctor fallback

`codemap-boost-setup` is for repair, diagnosis, explicit prewarming, and optional initial graph build, not normal installation. It maintains a private CRG venv (`crg-runtime` initially, then validated `crg-runtimes/<version>`), prefers `uv` and Python 3.12 with `venv` fallback, installs `code-review-graph[all]` only inside the venv, and probes Python/JavaScript/TypeScript/TSX parsers in Python `-I` isolated mode. It removes only provably plugin-owned old same-name global MCP overrides. It does not create new global registrations. Failed health or migration checks record a marker and return nonzero. `graphifyy[all]` is optional.

From the target project, a read-only diagnosis is:

```bash
node "<plugin-root>/scripts/setup.cjs" --doctor
```

Doctor installs nothing, does no MCP add/remove or graph build, and changes no AGENTS, ignore rule, or marker. It reports the actual Node version against `>=18.0.0`; Codex CLI availability and effective paths; private runtime and parser health; adapter compatibility; native MCP timeouts and shadowing registrations; target Git root and graph status; and actionable repair/restart guidance. A successful CRG status read proves only database readability, not adapter compatibility. Graph barrier failures distinguish lock waits from actual refresh errors. The running task's tool snapshot remains `UNKNOWN` to an external CLI; deferred discovery must be checked within a task. Exit `0` means `READY`, while exit `1` means attention is needed. Do not combine `--doctor` with `--build`, `--with-graphify`, or `--skip-install`.

Before removing or disabling the plugin, run `node "<plugin-root>/scripts/setup.cjs" --uninstall`. Codex runs no hook on plugin removal, so this is the only step that removes the CodeMap Boost block from `CODEX_HOME/AGENTS.md`. Text outside the block is left as is. If the block is left behind, it tells the agent to ignore it once the plugin is gone.

Run explicit setup from the target Git repository, so optional `.gitignore` and initial graph output land there. Normal daily use needs no setup; the read barrier performs build/update. `pip install --user` is not a repair method. The setup skill has exact commands and boundaries.

For repair or prewarming, the equivalent low-level commands are shown below for diagnosis only. Normal installation runs the plugin's own setup flow; do not manually overlay an active runtime. Replace `<plugin-data>` with the directory reported by doctor, and `<python>` with the platform-specific executable inside that venv.

```bash
# Preferred on macOS, Linux, and Windows when uv is available:
uv venv --python 3.12 "<plugin-data>/crg-runtime"
uv pip install --python "<plugin-data>/crg-runtime/<python>" --upgrade "code-review-graph[all]"

# Without uv on macOS or Linux:
python3 -m venv "<plugin-data>/crg-runtime"
"<plugin-data>/crg-runtime/<python>" -m pip install --upgrade "code-review-graph[all]"

# Without uv on Windows, using the Python Launcher:
py -3 -m venv "<plugin-data>/crg-runtime"
"<plugin-data>\crg-runtime\Scripts\python.exe" -m pip install --upgrade "code-review-graph[all]"
```

Optional `graphify` support is separate and installed only when needed:

```bash
# macOS or Linux:
python3 -m pip install "graphifyy[all]"

# Windows:
py -3 -m pip install "graphifyy[all]"
```

## Hook behavior and graph freshness

| Hook | Behavior |
| --- | --- |
| `SessionStart` | Injects shared retrieval guidance. In Git, maintains owned legacy overrides, managed guidance, and ignore rules; no CRG probe, install, or refresh. |
| `PreToolUse:MCP` | Prepares runtime and verifies or refreshes the graph synchronously before project graph calls. Failure denies that read with diagnostics. Global repository-registry calls do not depend on the current project graph. |
| `PreToolUse:Bash` | Adds one conditional graph-first hint for common source searches, atomically deduplicated per user turn. It does not deny or rewrite commands or refresh the graph. Filename, document, configuration, and log searches stay quiet. tgrep owns its separate command injection. |
| `UserPromptSubmit` | Injects shared guidance for structural requests; outside Git it writes no reminder state. |
| `SubagentStart` | Injects shared guidance without probing or rebuilding; actual graph reads still pass the MCP barrier. |

A full rebuild removes file-backed graph records before parsing current source. It clears old Windows-separator aliases, deleted-file nodes and reference edges, and associated embeddings while retaining metadata and provenance. The Python proof uses a v2 marker tied to actual CRG package identity and business-table schema/content hashes. The JavaScript fast path uses a v4 marker tied to source, selected runtime path, and lightweight `graph.db`/nonempty WAL stat signatures. If only the database stamp changes, the barrier checks the existing structural proof in a consistent SQLite transaction; normal embedding generation preserves vectors. Structural mismatches still require full repair. Hashes cover FTS and shadow tables but exclude embeddings, SQLite internals, the proof itself, and separately advanced Git SHA/branch metadata. Failed verification revokes the trusted marker.

Search reminders are isolated by host session, turn, session directory, and optional subagent ID. Each user follow-up resets the reminder even within the same turn. Only hash-named empty markers are stored under plugin-data `search-reminders/`; prompts, commands, and raw paths are not stored. Missing IDs or unwritable storage cause a stateless soft hint, so deduplication is not guaranteed. Command recognition is heuristic and says nothing definitive about cwd, intent, or permissions. Codex maps `exec_command`, including Code Mode inner calls, to `Bash` and `tool_input.command`; no outer JavaScript parsing is needed. Commands remain executable after the hint. Verification should inspect hook output, hint frequency, and a real graph query rather than only hook exit codes.

## Agent Dispatch, generated files, and boundaries

When both plugins are installed, Agent Dispatch selects and configures agents based on task, user preference, and available host models. CodeMap Boost owns graph freshness, barriers, and retrieval policy. A subagent does not refresh on startup; its actual graph read passes the synchronous barrier. For example, “find dependencies of auth” begins with graph evidence; Dispatch may suggest a search role if scope warrants it. Read-only crash diagnosis stays read-only, and an existing migration plan remains in effect. Agent selection does not turn a lookup into an edit.

Project output may include `.code-review-graph/` and `graphify-out/`. `SessionStart` adds them to `.git/info/exclude` without editing `.gitignore`; explicit setup may append them to the target project's `.gitignore` for a shared team rule. The global managed guidance block lives in `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`). The plugin does not use legacy host directories or environment variables, let `code-review-graph install` write third-party hooks/instructions/skills, or bypass Codex hook trust. PowerShell, pwsh, and Bash all invoke the same Node hook. `CODEMAP_BOOST_DISABLE_GRAPH=1` disables graph behavior entirely.
