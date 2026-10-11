# tgrep Search for Codex

Independent plugin `tgrep-search-codex@codex-toolshop` (0.1.3). Requires Node.js 18+, with no npm dependencies or MCP. Microsoft tgrep **v1.0.5** is the cold-install fallback; the plugin checks and validates upstream stable releases automatically. It manages services and private indexes per real Git worktree for text, string, and candidate-file search. CodeMap remains responsible for symbols, call chains, dependencies, and impact analysis. Read known files directly.

## Automatic operation

Trusted `SessionStart` hooks (startup/resume/clear/compact) and `SubagentStart` inject a short absolute CLI entry for the current installation and explicitly identify it as a CLI, not MCP. SessionStart means **starting or resuming a task**, not opening the Codex home page. Hook execution depends on host trust and enablement; the plugin does not approve hooks for the user.

In Git worktrees, `SessionStart` quickly launches a hidden supervisor. `UserPromptSubmit` and query calls touch its idle timer and restore a stopped service on demand. `SubagentStart` only emits the entry point and returns, regardless of directory; it does not probe repositories, check updates, install tools, or manage services. Non-Git `SessionStart` also only emits the entry point. `UserPromptSubmit` does not repeat the hint. Linked worktrees with a `.git` file are supported, with one service/index per canonical root. Services use the worktree root as cwd; relative search paths retain their meaning in the caller's directory.

Initial downloads and indexing do not block hooks. `starting/installing/pending` does not mean indexing is complete. When the binary exists, pending queries automatically use `--no-index` to scan disk; otherwise they try rg and identify the fallback on stderr. Download failures appear in doctor `lastError`. With neither tgrep nor rg available, the wrapper exits 2 rather than claiming no matches.

## Queries and diagnostics

Use the absolute path injected by the hook, or run from the plugin directory:

```bash
node scripts/tgrep.cjs search -F -n -- "needle" .
node scripts/tgrep.cjs search --fresh -n -- "pattern" src
node scripts/tgrep.cjs search --files -g "*.cpp" -- .
node scripts/tgrep.cjs search -e "first" -e "second" -- src
node scripts/tgrep.cjs search --root /explicit/directory -F -- "needle" /explicit/directory
node scripts/tgrep.cjs ensure
node scripts/tgrep.cjs doctor
node scripts/tgrep.cjs check-updates
node scripts/tgrep.cjs status
node scripts/tgrep.cjs stop
node scripts/tgrep.cjs --help
```

In Windows Git Bash, single-quote the complete script path when it contains spaces. Put flags before `--` and keep them separate (`-F -n`, not `-Fn`); pattern and paths follow `--`. With `-e/-f` or `--files`, all positional arguments are paths. `--root` selects the service root without changing path semantics. A Git subdirectory is promoted to the worktree root for the service, while the default query scope remains the caller's directory.

Non-Git `search` does not require `--root`: it scans resolved paths without inferring an index root or creating services/indexes. Relative and omitted paths still use caller cwd, and multiple paths form one unindexed scan. Missing/unreadable paths pass through to the backend and return errors without broadening scope. Non-Git `ensure/status/doctor/stop` still require explicit `--root`. Explicit paths outside the worktree also use live scans. Existing Windows query paths resolve short names and junctions before scope checks and backend invocation, so output may use real long paths. Missing/unreadable paths remain unchanged for backend diagnostics. Unix path behavior is unchanged.

`ensure` synchronously diagnoses installation, then requests service startup on success; it does not establish index readiness. `doctor/status` emit JSON containing root, index, runtime, activeVersion, serviceVersion, updates (last check/result/error), management state, and recent installation/service errors. Exit codes: 0 means matches or successful management, 1 means no matches, and 2 means an error. Unknown or unmappable flags explicitly fail with 2.

Supported flags are defined by `switches/values` in `scripts/tgrep.cjs`: case handling, fixed strings, word/line regexes, inversion, file/count/JSON output, line numbers, context, multiple patterns, glob/type/encoding/file size, hidden/ignore, and follow. `--stats` requires tgrep and is not blindly forwarded to rg. Upstream `--index-path`, serve/index, and arbitrary tgrep-only arguments are not passed through by search, preventing queries from targeting unrelated indexes.

## Consistency and boundaries

- Services and queries default to a 64 MiB file limit, the same root, and a private index path. Ignore rules follow tgrep defaults. Queries changing ignore rules, size, encoding, or traversal scope scan live without changing the active index policy.
- Readiness requires discovery PID identity matching the current supervisor's child, valid TCP status, completed indexing, and no pending/overdue/error reconcile state. Restored indexes also require an initial successful reconcile. Manager identity/state is checked again after a query; a disconnected manager must not silently fall back to stale disk indexes.
- Empty indexed results, including empty file listings, are checked by live scans. Watcher propagation is delayed, so **nonempty results may still be incomplete**. Use `--fresh` for important post-edit decisions, completeness checks, or current disk contents.
- The 64 MiB default does not cover every file. Use `--no-max-filesize` or `--max-filesize SIZE` for larger files; these queries scan live. The wrapper explicitly passes the default limit, including for directly named files.
- tgrep detects BOMs by default; non-UTF-8 input may be repaired to U+FFFD. Explicit encodings such as `-E gbk` use live scans. Use rg for byte-exact search. rg differs in ignore rules, binary extensions, and encoding, so fallback does not promise byte-for-byte equivalence.
- Queries wait at most 120 seconds and buffer at most 32 MiB stdout. Limits produce explicit error 2 instead of silent truncation. Narrow paths or use `-l/-c/-m` to limit output. Error 2 preserves actual errors; changing engines must not hide syntax or permission failures.

## Private runtime and lifecycle

The default data directory is `$CODEX_HOME/plugins/data/tgrep-search-codex-codex-toolshop`, or `~/.codex/plugins/data/tgrep-search-codex-codex-toolshop` without CODEX_HOME. Host `PLUGIN_DATA` takes precedence; `TGREP_SEARCH_HOME` has highest priority for tests or manual isolation.

Storage uses `runtime/<version>/<platform-arch>` and `worktrees/<canonical-root-sha256>/indexes/<version>`. Live legacy managers without a version field remain bound to 1.0.5 and the original `index` directory. No `.tgrep` is written into projects. `release.json` records official cold-install asset URLs and SHA256 values for Windows/macOS/Linux x64/arm64. Installation downloads, verifies SHA256, extracts only the executable, checks its version, and atomically publishes into a separate version directory. It does not download main or install Cargo by default. A receipt records the binary SHA256; later corruption causes an explicit error directing the user to remove that runtime version directory and run `ensure`. See the [pinned official release](https://github.com/microsoft/tgrep/releases/tag/v1.0.5).

Downloads prefer host curl and its proxy settings, falling back to Node fetch when curl is absent. Node 18 fetch may not honor shell proxy variables. Windows explicitly uses `System32/tar.exe` for zip extraction; macOS/Linux use tar. Downloads, installation, and services use locks, reclaiming only confirmed dead owners. Live PIDs with unconfirmed identity are never killed; doctor explains conservative blocking.

The supervisor authenticates control requests with a random token stored only in private state, never hook output or logs. Windows children use `windowsHide: true` and `shell: false`. `stop` asks an identity-verified supervisor to stop; that supervisor closes its own ChildProcess rather than killing arbitrary persisted PIDs.

Services are reclaimed after **30 idle minutes** since the last query or UserPromptSubmit. For immediate exit before stopping/disabling the plugin, run `stop`; otherwise the existing supervisor expires normally. Forced supervisor termination or OS crashes are outside normal shutdown and may leave orphan tgrep processes. The plugin never kills unowned processes based only on stale PIDs; use OS process tools to verify paths and command lines before manual cleanup.

Optional environment variables (set before service startup; run `stop` and restart after changes):

| Variable | Purpose |
| --- | --- |
| `TGREP_IDLE_MS` | Idle timeout in milliseconds; minimum 5000, default 1800000 |
| `TGREP_QUERY_TIMEOUT_MS` | Query timeout in milliseconds; minimum 1000, default 120000 |
| `TGREP_MAX_CPU` | Upstream serve CPU percentage, 1..100; upstream default is 50 |
| `TGREP_MAX_MEMORY_MB` | Upstream serve memory budget in MiB, 1..1048576; otherwise derived from system memory upstream |

`TGREP_DISABLE_UPDATES=1` disables automatic checks for controlled environments/tests. Explicit `check-updates` still forces a check.

The memory budget limits upstream indexing, not OS memory consumption. Data may remain for reuse; deleting caches after uninstall is an explicit user choice.

## Weekly upstream updates

Git SessionStart and ordinary query/ensure entry points check `https://api.github.com/repos/microsoft/tgrep/releases/latest` in the background every **7 days (604800000 milliseconds)**. Implicit scan-only searches outside Git do not check updates. There are no separate reminders, dialogs, or timers when unused; the next use performs the check. Frequency is measured from the last attempt, including failures, preventing repeated network calls on every query. `check-updates` forces an immediate retry. Scheduling/check locks and timestamps deduplicate tasks sharing data.

Only stable releases, official `microsoft/tgrep` assets for the six supported platform/architecture combinations, and their `assets[].digest` SHA256 are accepted. Missing digests, incompatible names/platforms, download errors, hash mismatches, or nonnewer versions leave the active version unchanged. Doctor records failures without disrupting existing search. Locally calculated hashes are not substituted for official verification evidence.

A candidate is tested in a separate temporary fixture for version, CLI, index, serve/status/reconcile, indexed search, no-match exit codes, file lists, and `--no-index` freshness. Only complete success atomically publishes `active-release.json`. Failed candidate installations may remain for retry; old binaries/indexes are not replaced or deleted in place.

Running services retain their startup version. Queries use that manager's declared version and matching index; legacy managers remain bound to 1.0.5/legacy index. Active-version changes do not forcibly restart services. After idle exit or explicit stop, the next start uses the new version and separate index, avoiding new CLIs reading old service indexes. Doctor may show different active and service versions.

For shared-egress API limits such as GitHub Actions, explicitly set `TGREP_GITHUB_TOKEN` (CI uses its read-only built-in token). Authentication goes only through Node fetch to the fixed official latest API, without redirects. Tokens are excluded from curl arguments, state files, and logs. Without a token, existing curl/proxy behavior remains available; ordinary users need no token.

This updates the **upstream tgrep tool**, not Codex plugin source. It does not change marketplace or plugin caches.

## Validation

```bash
npm test
npm run test:smoke
npm run test:updates
```

Unit tests use isolated temporary directories for argument boundaries, path meaning, fallback mapping, locks, and exit codes. Smoke tests download and verify the official pinned package and start a real service. Git repositories, test commits, and linked worktrees are created only under mkdtemp, testing ready-index queries, subdirectory scope, fresh/new files, stopping, idle reclamation, and worktree isolation without modifying user projects.

`test:updates` installs the cold version in isolated data, validates the real candidate protocol, and calls the official latest endpoint through public check-updates. If latest equals the cold version, it asserts no switch. Ordinary smoke uses TGREP_DISABLE_UPDATES=1 to avoid drift from future releases and separately simulates active-version changes to verify live services retain their original versions.
