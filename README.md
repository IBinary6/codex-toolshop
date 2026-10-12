# Codex Toolshop

`codex-toolshop` is a Codex plugin marketplace maintained by IBinary6 for reverse engineering, debugging, code search, project conventions, agent dispatch, and local knowledge. Install plugins as needed; scripts and host hooks handle routine setup and maintenance.

## Quick start

Add the marketplace once:

```bash
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
```

Install the plugins you need:

```bash
codex plugin add dbg-codex@codex-toolshop
codex plugin add codemap-boost-codex@codex-toolshop
codex plugin add tgrep-search-codex@codex-toolshop
codex plugin add cpp-style-enforcer-codex@codex-toolshop
codex plugin add agent-dispatch-codex@codex-toolshop
codex plugin add local-knowledge-codex@codex-toolshop
codex plugin add conversation-namer-codex@codex-toolshop
codex plugin add system-proxy-codex@codex-toolshop
codex plugin add context7-codex@codex-toolshop
codex plugin add exa-codex@codex-toolshop
codex plugin add tavily-codex@codex-toolshop
codex plugin add microsoft-learn-codex@codex-toolshop
codex plugin add fetch-codex@codex-toolshop
codex plugin add sequential-thinking-codex@codex-toolshop
```

After installation or an upgrade, open a new Codex task to reload hooks, skills, and MCP configuration. If the host marks a new or changed hook as untrusted, review and trust it in `/hooks`. Enabling a plugin does not grant trust to its hooks; plugins do not write their own trust hashes.

## Platform support

The marketplace primarily targets Windows and macOS. Dbg and tgrep also provide Linux deployment scripts and CI coverage. Each plugin's documentation defines its dependencies and compatibility; one plugin's validation does not establish support for the entire marketplace. All plugins require at least Node.js 18:

| Platform | Supported terminals and runtimes | CI runner |
| --- | --- | --- |
| Windows | PowerShell, Git Bash, Windows Python launcher | GitHub Actions `windows-latest` |
| macOS | zsh, bash, `python3`, common Apple Silicon toolchains | GitHub Actions `macos-latest` |
| Linux (Dbg, tgrep) | bash; Dbg requires Python and applicable debugging tools, while tgrep uses a pinned release | Plugin-specific GitHub Actions `ubuntu-latest` |

Plugins that need Python locate it themselves, so a system Python that is too old (stock macOS ships 3.9) does not block them. Local Knowledge (3.11+) and System Proxy (3.10+) try `python3` and `python`, versioned names such as `python3.12`, Homebrew and python.org locations, and uv-managed interpreters, plus `py -3` on Windows. Choose one explicitly with `LOCAL_KNOWLEDGE_PYTHON` or `SYSTEM_PROXY_PYTHON`. Dbg falls back to an isolated uv-managed Python 3.12.

`codemap-boost-codex` also requires Git and either `uv` or Python with `venv` support. For `cpp-style-enforcer-codex`, `clang-format` and `iconv-lite` are optional. Research plugins require Node.js 20 or later; Fetch also needs `uvx` on first actual use. Other research tools do not start Python services.

## Plugin catalog

| Plugin | Purpose | Everyday use |
| --- | --- | --- |
| [Context7](plugins/context7-codex/README.md), [Exa](plugins/exa-codex/README.md), [Tavily](plugins/tavily-codex/README.md) | Independent plugins for library documentation, web search, extraction, and research. | Enable each separately in Codex. Personal keys live in `$CODEX_HOME/<plugin-name>/config.json`. |
| [Microsoft Learn](plugins/microsoft-learn-codex/README.md), [Fetch](plugins/fetch-codex/README.md), [Sequential Thinking](plugins/sequential-thinking-codex/README.md) | Independent plugins for official documentation, web content, and stepwise analysis. | No keys required; only Fetch starts a Python backend, on actual use. |
| [research-tools-codex](plugins/research-tools-codex/README.md) | Optional combined version of the six research tools, and the maintenance source for the independent packages. | Use one combined entry or independently toggled plugins; avoid enabling duplicate providers. |
| [Dbg](plugins/dbg-codex/README.md) | Discover tools installed through Scoop, Homebrew, or manually; deploy extensions and MCPs for x64dbg, Ghidra, WinDbg, and IDA. | Initial loading deploys automatically. Run `dbg doctor` to rediscover, update, or repair. Scripts explicitly skip incompatible versions. |
| `codemap-boost-codex` | Bundled `code-review-graph` and Serena semantic MCPs for structure, symbols, references, and impact analysis. | Prepare isolated runtimes and maintain graphs automatically; locate structure with the graph and use Serena as needed. Serena Dashboard, browser launch, and GUI logs are disabled by default. |
| [tgrep-search-codex](plugins/tgrep-search-codex/README.md) | Prepare a pinned tgrep release and manage a text index and background service for each Git worktree. | Task startup prepares the tool. Use the search entry supplied by the hook. Unready or unhealthy indexes fall back to live scans; use `--fresh` after edits or for completeness checks. |
| `cpp-style-enforcer-codex` | Automate C++ style workflows: clang-format, copyright headers, BOM, cpplint, and pre-commit checks. | Edit normally. Hooks process edited C/C++ files and check staged C++ files before `git commit`. |
| `agent-dispatch-codex` | Assign bounded investigation, planning, production, verification, and review tasks across product, design, QA, research, operations, and engineering. | New tasks receive dispatch policy. Validate the deliverable, collect subagent results, and release agents after integration. Code evidence, implementation, testing, and review remain distinct stages. |
| `local-knowledge-codex` | Indexed local knowledge for error solutions, preferences, facts, decisions, and workflows. | Recall by scope and relevance in read-only mode. Write only when explicitly requested or when verified reusable content is authorized under host policy. |
| `conversation-namer-codex` | Consistent Codex task titles based on creation date, task type, and actual topic. | A lightweight model names new tasks in the background. Bulk project renaming requires a two-column preview and confirmation. |
| `system-proxy-codex` | Enable Codex system proxy support and safely configure `.env` with Python. | Use the system proxy by default, or use `system-proxy-setup` to detect or specify ports such as `7897` or `7890`. |

## Enabling research tools

You can install all six research plugins and enable or disable them separately in Codex. Installation and activation are separate states. Disabling a plugin preserves its private configuration and key. Reload or restart Codex when prompted to refresh tools and processes. These MCPs do not require separate CC Switch registration.

Each independent plugin uses `~/.codex/<plugin-name>/config.json`, relocated under `CODEX_HOME` when set. Exa uses `~/.codex/exa-codex/config.json`; Tavily uses `~/.codex/tavily-codex/config.json`. Setup creates an empty template only when absent. Users supply their own `apiKey`; the three providers that do not require keys have no key field. Private configuration is excluded from public packages and survives reinstallation and upgrades. The next call reads key changes.

The optional combined package keeps its three original fields in `~/.codex/research-tools/config.json`, separate from independent plugin configuration.

Context7, Exa, and Tavily use skill-guided commands on demand: Context7 runs the official `ctx7` CLI, while Exa and Tavily call their official REST APIs. These three have no persistent MCP entry point. Keys come from their private JSON files. Context7 requires Node.js >=22.13.0 and npm, prepares a pinned CLI on first use, and allows anonymous documentation queries. Exa and Tavily use existing API keys without another login.

Microsoft Learn, Fetch, and Sequential Thinking retain lightweight MCP entry points. Tool discovery does not access the network, prepare dependencies, or start backends; Fetch holds a Python backend only after an actual call. The combined package retains its original MCP tools, so avoid enabling duplicate forms. CodeMap manages its graph and Serena MCPs. Codex itself manages `node_repl` version paths and host bindings.

## Using Dbg

When `dbg-codex` first loads in a new Codex task, scripts detect installed tools, download compatible extensions, prepare isolated runtimes, and generate local paths and MCP launch settings. The plugin supplies its own MCPs without separate CC Switch registration. After installing, upgrading, or moving a tool, run:

```sh
dbg doctor
```

| Platform | Discovery sources | Deployable components |
| --- | --- | --- |
| Windows | Scoop user/global/custom roots, active `current`, registered installations, PATH, common manual locations | x64dbg/x32dbg, Ghidra, WinDbg, compatible IDA |
| macOS | Actual Apple Silicon/Intel Homebrew prefixes, active formulas, relevant installed casks, Applications, PATH, common manual locations | Ghidra, compatible IDA |
| Linux | Actual Homebrew/Linuxbrew prefixes, active formulas, PATH, common manual locations | Ghidra, compatible IDA |

Dbg derives host, Python, JDK, extension, and MCP paths from the current machine. It does not reuse another machine's absolute paths. Missing software is skipped. IDA 8.2, IDA Free, and versions with unconfirmed compatibility are explicitly unsupported. Arbitrary custom directories may require an entry in Dbg's `config.json`, followed by another doctor run.

Users install native debugging software themselves. Ghidra requires initial GUI extension activation; actual debugging requires the corresponding tool and target to be open. On macOS/Linux, `dbg` is installed in `~/.local/bin`; doctor explains how to add it to PATH if necessary. Deployment and target connection are separate states; see [Dbg configuration and validation](plugins/dbg-codex/README.md).

Disabling or uninstalling Dbg reduces the MCPs loaded by Codex. Extensions already deployed into tools, isolated runtimes, and backups remain; plugin removal does not delete these files.

## Naming tasks

After installing `conversation-namer-codex`, the first user message triggers one background naming attempt. The default model is `gpt-6-luna`, using the lowest supported reasoning effort from the live catalog and standard service tier. It produces `MMDD<separator>TYPE<separator>Topic` (the separator is U+FF5C). Set `model: "auto"` explicitly to restore automatic low-cost model selection. The main task proceeds without waiting. The date comes from `createdAt` converted to `Asia/Shanghai`; default types are `FEA`, `DES`, `FIX`, `OPT`, `REL`, `EXP`, `DOC`, and `RES`.

Automatic naming applies only to the current primary task. It preserves the title when renaming is prohibited, the title has changed, the topic is unclear, or a call fails. See the [plugin documentation](plugins/conversation-namer-codex/README.md) for model selection, status, and host UI refresh limits.

To organize titles in the current project, ask:

```text
Rename the conversation titles in the current Codex project.
```

Bulk mode is limited to the current project and first presents a `Before / After` table. Only after confirmation does it recheck and update each title. It does not change project names, task content, membership, ordering, pins, or archive state. Request Chinese type labels explicitly if desired.

## Using Agent Dispatch

New tasks automatically receive dispatch policy after installation:

- The primary agent retains goals, requirements clarification, key business and architecture/interface decisions, decomposition, result review, and integration.
- Built-in models focus on GPT-6 Luna, GPT-6 Sol, GPT-6.1 Sol, and GPT-6 Astra. Code and test writing prefer host-supported 6.1 Sol high, with 6 Sol medium as fallback. Ordinary planning/review uses Sol high; critical complex work may use Astra. Luna max handles exploration, logs, routine documents/structured data, extraction, code evidence, and established test execution. Low-cost evidence work remains separate from code writing and does not silently escalate when unavailable.
- Bounded materials, document/data processing, design deliverables, coding, and fixes may go to writable subagents. Choose role, model, and effort based on complexity, context, risk, availability, and explicit user preference, rather than job titles.
- Delegate independent bounded tasks in parallel when beneficial. Keep trivial reads, small edits, and tightly coupled steps in the primary agent.
- Subagents execute their assigned tasks without recursive delegation and report deliverables, changed files, validation, and evidence. Stop them promptly after integration, when blocked, or when no longer needed.
- Choose models and effort by ambiguity, constraints, risk, availability, total completion cost, and explicit user or skill choices. Do not assign Luna solely by domain keywords or add a special role/switch for local commit preparation. Pass model and effort explicitly for unpinned writers.
- Independently review nontrivial deliverables after appropriate validation. Default candidates include Astra/xhigh and Astra/ultra for higher risk. Reassess each new or reused reviewer against actual responsibility, ambiguity, risk, quality, and cost; explicit user choices take precedence. Small follow-up reviews still require model/effort verification. Evidence collection and established tests are distinct from review. Verify substantive findings, make bounded fixes, rerun affected checks, and review again. Keep small changes and primary-only requests proportionate.
- Match verification to the deliverable: requirements for products, experience and consistency for designs, acceptance reproduction for QA, sources for research, definitions for data, and relevant tests for code. Only proven defects affecting the current acceptance goal justify rework. For code, check build configuration and call paths, and preserve user debugging branches without defect evidence.
- Role profiles are candidate defaults; keywords grant neither authority nor mandatory delegation. A model-only override uses applicable plugin effort defaults rather than inheriting a parent's ultra. Preserve explicit settings and verify supported combinations with the host. Verify reviewer models from runtime metadata; mark unobservable settings unconfirmed. Hooks communicate this requirement but do not enforce actual spawn models. See the [Agent Dispatch documentation](plugins/agent-dispatch-codex/README.md).
- Routing extracts hints about read-only scope, primary-only work, agent limits, and existing plans, and identifies them as heuristic suggestions. Product behavior and quotations are not task restrictions; old routes do not create constraints across turns. Follow the full conversation and latest explicit request while retaining actual user constraints.
- Ordinary Bash/agent calls and single Git CLI commands do not produce routing hints. Only when the primary explicitly delegates complete local commit preparation under a user request or skill workflow may one writable agent in the same workspace inspect state/diffs, stage exact files, and return a summary, checks, HEAD/index tree OIDs, and commit message. The primary still performs commits, remote operations, and history rewrites.
- No manual setup is needed. New tasks receive routing policy and named agents are generated in Git projects. Non-Git tasks use host-loaded capabilities or the primary agent without assuming named roles exist. `agent-dispatch-setup` inspects or overrides configuration.
- Select specialist tools and skills for the actual work; use code graphs for code structure tasks only. Writable roles and routing do not authorize external messages, publishing, spending, or real-data changes.
- Windows PowerShell/Git Bash and macOS zsh/bash are supported. Terminal shell selection does not change Node.js hook execution.
- Global configuration lives in plugin `PLUGIN_DATA/config.json`; project configuration lives in `.agent-dispatch-codex/config.json`.

To inspect the effective policy, ask:

```text
Use agent-dispatch-setup to show the current project's effective dispatch policy.
```

## Using CodeMap Boost

CodeMap/Serena and tgrep runtimes can check upstream stable releases weekly, validate candidates in separate directories, and use them for later launches; failures preserve the previous version. CodeMap also calls the native Codex update entry weekly for installed plugins from the official `codex-toolshop` marketplace. It does not wake the computer when unused. See the [CodeMap documentation](plugins/codemap-boost-codex/README.md) for update controls and read-only status commands.

Native MCP launchers and hooks perform the following:

- A lightweight Node MCP exposes CRG tools before preparing or launching `code-review-graph` on actual use. Windows main-thread model warmup is preserved. Heavy backends are reclaimed after 10 idle minutes following the last completed backend work and restart on demand. Unfinished preparation, requests, callbacks, or unconfirmed cancellation block reclamation.
- MCPs are exposed through the plugin's `.mcp.json`, without registering duplicate global servers. Runtime installation prepares only required dependencies.
- Serena 1.7.0 is installed into an isolated private venv with Dashboard, browser launch, and GUI logs disabled. Existing MCP manager configuration is preserved. Activate the real target project before semantic queries rather than using the plugin directory.
- A bounded managed block in `$CODEX_HOME/AGENTS.md` is updated while preserving surrounding content. Broken boundaries are reported instead of guessing a replacement range.
- A target Git worktree build/update completes before actual graph reads. Untracked source files trigger a full build using a temporary Git index.
- For structure, dependencies, call chains, and impact, query available graph tools and verify against source. Rules remain at session start, structure requests, and subagent entry. Common source searches receive one short reminder per user turn, reset after new input, without blocking commands or repeating refreshes.
- Session-start and post-edit hooks do not probe, install, or refresh CRG. A synchronous barrier checks source/database fingerprints and prepares a fresh index before reads. Read known files directly. Prefer the available tgrep entry for repository text and file discovery, using live scans for fresh content or unavailable indexes. If graph tools are unavailable or coverage is incomplete, verify source and state the limit.
- `.code-review-graph/` and `graphify-out/` are added to the repository's `.git/info/exclude`, without changing project `.gitignore`.

For manual warmup or troubleshooting, ask:

```text
Use codemap-boost-setup to configure CodeMap Boost.
```

Useful checks:

```bash
codex mcp get code-review-graph --json
codex mcp get serena --json
codex plugin list
```

## Combining CodeMap, Serena, tgrep, and Agent Dispatch

A trusted tgrep `SessionStart` hook prepares tgrep and starts `serve` when a Git task starts or resumes. The service creates missing indexes; no manual `tgrep index` or `tgrep serve` is needed. Initial downloading/indexing runs in the background, and the query entry handles unready state. Non-Git tasks and subagents also receive the absolute CLI entry. Subagent hints only describe invocation and do not install, update, or start services. Opening the Codex home page alone is not a task-start hook event.

| Need | Approach |
| --- | --- |
| Call chains, symbol relationships, references, impact | Query CodeMap, then verify source. |
| Exact definitions, implementations, references | Narrow the scope with the graph and use Serena/LSP as needed; use source/text evidence when language services are unavailable. |
| Ordinary repository text search | Use the injected tgrep CLI wrapper and its healthy index. |
| Recent edits or complete current results | Use wrapper `--fresh` scans or `rg`. |
| File discovery | Use `--files` with a healthy index; use `--fresh --files` or `rg --files` for a live listing. |
| Known files | Read directly. |

The wrapper isolates state by real worktree and reuses services. It scans live when indexing is incomplete, service state is unhealthy, or indexed results are empty. Filters and size limits still apply; consult [tgrep documentation](plugins/tgrep-search-codex/README.md) for special encodings, raw bytes, or wider scope. Use graph tools for structural location, supplement missing coverage with Serena or text candidates, and return to graphs or symbols when needed. Stop once evidence is sufficient; every task need not use all tools. tgrep independently owns installation, startup, and fallback; see [CodeMap](plugins/codemap-boost-codex/README.md) for Serena language-service dependencies and activation.

The task directory may differ from the project: pass the target `repo_root` to graph queries, activate the target in Serena, and use its `workdir` or explicit search paths. tgrep `search` also scans explicit paths outside Git; `--root` chooses service scope without changing relative path semantics. Check the actual graph and Serena tools and the tgrep CLI separately. If one is unavailable, continue with other capabilities and rediscover it when needed; a temporary absence is not permanent unavailability.

These four plugins do not require one another to be installed or enabled. Agent Dispatch only assists task allocation; it does not own retrieval, language-service readiness, or graph refresh. Without it, the primary agent works directly. Without tgrep, scan live; without graphs, use Serena/source; without Serena or complete compilation parameters, use graphs/text and state evidence limits. Text matches are not proven semantic references. Since CodeMap 0.1.39, Serena C/C++ activation reuses compilation databases or evaluates supported Windows VC++ parameters into private plugin storage. Ambiguous multi-project selection requires an explicit choice; see [Serena project boundaries](plugins/codemap-boost-codex/README.md).

## Using Local Knowledge

New tasks load local knowledge rules:

- Load `pinned` preferences for the current workspace at session start.
- Recall relevant preferences, facts, decisions, and workflows for ordinary questions. Use `local-knowledge-recall` for explicit queries; no matches must not inject neighboring scopes.
- Recall error solutions only when tool output explicitly indicates a real failure. Successful or unknown-status output must not trigger recall merely because it contains example error text.
- Automatic recall opens existing databases read-only, without creating databases/tables or migrating. Query failures and no matches are reported separately; use the setup/migration skills when needed.
- Words such as “remember” or “save” are hints, not authority; quotations do not authorize writes. Check current instructions, verified evidence, and host policy before `local-knowledge-save` selects type, scope, recall policy, and cues. Historical records do not override current instructions or authorization.
- Repository/workspace knowledge is isolated by normalized absolute paths. Subdirectories inherit their repository/workspace knowledge without leaking adjacent scopes.
- Credentials such as passwords, tokens, API keys, and private keys are rejected by default. `confidential` records require explicit recall.
- Updating records preserves sensitivity, manual-recall settings, and other metadata not explicitly changed. General knowledge and historical errors use separate data layers.

The default SQLite file remains `~/.bugdb/bugs.db` to preserve existing data. Prefer `LOCAL_KNOWLEDGE_HOME`; legacy `BUGDB_HOME` remains supported. Use `local-knowledge-migrate` for records still stored elsewhere; migration does not delete source files.

Example requests:

```text
Use local-knowledge-recall to find previous solutions for this error.
Remember my preference: answer in English by default.
Use local-knowledge-save to save the fix we just verified.
```

The plugin ID changed to `local-knowledge-codex`. Old IDs do not migrate automatically: disable/remove the old plugin and install the new one. No database rename or copy is needed.

## Using C++ Style

New sessions prepare only the global template. Project configuration is created on demand after an actual C/C++ edit:

- `PostToolUse` records edited C/C++ files without immediately rewriting source.
- `Stop` processes formatting, BOM, copyright headers, line endings, and cpplint at the end of the turn, then triggers final verification.
- Edited C/C++ files in native Visual Studio projects require CRLF. Other projects select `lf`, `crlf`, or `preserve` through `lineEnding`. Missing final newlines use the same ending; this also works when clang-format or legacy style checks are disabled.
- `PreToolUse` recognizes actual `git commit` commands and checks staged C/C++ files without rewriting them before commit.
- Existing formatter configuration is respected. Read-only checks do not rewrite BOMs, and failed checks cannot be reported as successful.
- The global template is `~/.codex/cpp-style-template.json`.
- Project configuration is `.codex-cpp-style/cpp-style.json`.
- Existing `.claude-cpp-style` projects remain supported without migration.

Optional dependencies can be prepared in a terminal:

```bash
# macOS
python3 -m pip install clang-format==18.1.8

# Windows
py -3 -m pip install clang-format==18.1.8
```

`iconv-lite` must be supplied by the plugin package or data directory. Installing it in an arbitrary working directory does not make it resolvable by the runtime. Without it, GBK conversion/BOM handling is safely skipped.

## Updating installed plugins

When new marketplace versions are available:

```bash
codex plugin marketplace upgrade codex-toolshop
codex plugin add dbg-codex@codex-toolshop
codex plugin add codemap-boost-codex@codex-toolshop
codex plugin add tgrep-search-codex@codex-toolshop
codex plugin add cpp-style-enforcer-codex@codex-toolshop
codex plugin add agent-dispatch-codex@codex-toolshop
codex plugin add local-knowledge-codex@codex-toolshop
codex plugin add conversation-namer-codex@codex-toolshop
codex plugin add system-proxy-codex@codex-toolshop
```

Restart Codex or open a new task. Check installed versions with:

```bash
codex plugin list
```

## Troubleshooting

- A newly installed debugging tool is missing: run `dbg doctor`, inspect `not_installed`, `unsupported`, or error details, then open a new task after deployment. Ghidra also needs GUI extension activation.
- `failed to parse plugin hooks config ... unknown field description`: update the plugin and ensure cached `hooks/hooks.json` has only `hooks` at its top level.
- No CodeMap graph: confirm the target is a Git repository and run `code-review-graph status`. New sessions wait for the initial build before graph use.
- CodeMap does not run: check `CODEMAP_BOOST_DISABLE_GRAPH=1`.
- tgrep is unready or misses a new file: use `--fresh` and inspect wrapper `status`/`doctor`. Initial download, indexing, and change reconciliation are different phases. Trust hooks through the host UI; the plugin does not grant itself trust.
- C++ formatting does not run: check `clang-format`. Missing formatters skip formatting while cpplint and other checks continue.
- A hook misbehaves or you want to compare behavior: hooks run inside their runner process, which saves one Node start-up (about 40 ms) per hook. Set `TOOLSHOP_HOOKS_CHILD_PROCESS=1` to run every hook in its own Node process, as earlier versions did.
- CodeMap Boost leaves its section in `~/.codex/AGENTS.md` after removal: Codex runs no hook when a plugin is removed, so run `node "<plugin-root>/scripts/setup.cjs" --uninstall` before removing it, or delete the text between `<!-- codemap-boost-codex:start -->` and `<!-- codemap-boost-codex:end -->`. A block left behind tells the agent to ignore it.
- Agent Dispatch is inactive: open a new task, inspect `/hooks`, and trust the current hook hash.
- Automatic naming does not run: enable `conversation-namer-codex`, open a new task, inspect `/hooks`, and trust the current hook hash. Hook upgrades require another new task.
- Local Knowledge reports that Python 3.11+ is missing: install one (for example `brew install python@3.12` or `uv python install 3.12`) or point `LOCAL_KNOWLEDGE_PYTHON` at it. Detection allows each candidate 3 seconds and remembers the interpreter it verified.
- Local Knowledge cannot find history: run `local-knowledge-setup`, check `~/.bugdb/bugs.db` and overrides from `LOCAL_KNOWLEDGE_HOME` or legacy `BUGDB_HOME`. Use `local-knowledge-migrate` for data still stored elsewhere.
