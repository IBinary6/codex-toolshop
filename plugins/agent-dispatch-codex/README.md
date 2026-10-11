# agent-dispatch-codex

Agent Dispatch brings the primary-agent orchestration model of Claude Code's `agent-dispatch` to Codex. The primary agent owns requirements, key plans and public-contract decisions, decomposition, review, and integration. Matching subagents may directly perform clearly bounded investigation, planning analysis, deliverable work, verification, and review. They do not recursively delegate, and they report deliverables, validation evidence, and results.

## Relationship to the Claude Code version

Both versions follow the same division of responsibility: the primary agent keeps key decisions, review, integration, and ordinary serial Git work; bounded subtasks go to matching agents. Only a user request or an explicit skill workflow for complete local commit preparation can assign that preparation to one designated writable agent in the same workspace. Results are integrated before idle subagents are released.

| Capability | Codex version | Claude Code version |
| --- | --- | --- |
| Primary-agent tool handling | Ordinary calls receive no `PreToolUse` hint by default, avoiding redundant context and false blocks | A `PreToolUse` allowlist blocks other tools and requires `Agent` |
| Subagent identity | `SubagentStart` defines the role boundary; optional `agent_id` is not used for hard blocking | Hook input carries `agent_id`, which can exempt subagents |
| Routing hints | `SessionStart` and `UserPromptSubmit` inject concise policy and route suggestions | A blocked call causes dispatcher instructions on the next prompt |
| Git boundary | Ordinary Git CLI stays quiet and serial in the primary agent; one designated agent may prepare a complete local commit when explicitly requested, while the primary agent performs the final commit, remote operations, and history rewrites | Safe Git runs directly; dangerous Git is blocked |
| Configuration | `PLUGIN_DATA` plus project `.agent-dispatch-codex`, with Codex agent profiles | `~/.agent-dispatch` plus project `.agent-dispatch` |

Codex has a different hook event model, so this plugin does not copy the Claude version's blanket deny rule. Codex `PreToolUse` reports standard tool events and maps `exec_command`, including Code Mode inner calls, to `Bash`. Its `agent_id` is optional; absence does not prove that a call came from the primary agent. A single tool call also cannot establish whether a task should be delegated.

| Hook | Behavior |
| --- | --- |
| `SessionStart` | Creates missing configuration scaffolding and injects primary-agent policy. |
| `UserPromptSubmit` | Adds one concise routing hint for a matching substantive prompt. |
| `PreToolUse` | Disabled by default. If enabled, adds a soft hint for MCP tools outside the lightweight list or recognized registry state changes; it never denies. |
| `SubagentStart` | Tells subagents to execute assigned work directly without further delegation. |

Ordinary Bash commands and single Git CLI commands do not produce task-routing hints. Git subcommands and arguments are treated as command data; natural-language requests or mixed non-Git commands still route by the whole prompt. `shell_heads` supports optional command analysis but is not a sandbox or authority boundary. The default `pre_tool_nudge` is `false` because one command is insufficient to choose a role or model.

## Automatic operation after installation

No setup command is needed for normal installation. Once enabled, a new Codex task triggers `SessionStart`, which creates missing configuration scaffolding, merges applicable layers, generates `.codex/agents/*.toml` in the current Git project, and injects the primary-agent policy. Each later `UserPromptSubmit` adds at most one concise suggestion based on that prompt.

A non-Git directory can receive generic routing guidance, but the plugin does not write `.codex/agents` in arbitrary directories. Named roles are usable only after the host loads them. Installation or a role in the defaults does not prove the current task has loaded that role. When it has not, the primary agent uses available host capabilities or performs the work directly. Open a new task to load changed plugin settings; review and trust changed hook hashes in `/hooks`.

`agent-dispatch-setup` is for inspecting effective configuration or adding overrides. Routing keywords are suggestions, and the primary agent decides from context and the value of delegation. An actionable existing plan should be executed without redundant replanning. Validate substantive work proportionately and then obtain an independent review; small edits need a proportionate process. Read-only evidence subtasks remain read-only. The primary agent can perform short lookups and small edits directly, while long logs, bulk documents, and routine organization generally fit the configured low-cost route. Text length alone never triggers delegation.

Routing first reads scope cues, then intent and risk. A read-only cue must appear in a request clause; arbitrary product descriptions such as “read-only mode” do not prohibit implementation. This is a heuristic, not a natural-language authority parser. Every automatic hint states that it is an `Agent Dispatch candidate suggestion` inferred only from the current message. Quoted material, product behavior, and earlier hints cannot replace user instructions. A later turn without a hint does not preserve an old route; the primary agent continues the authorized objective and actual unchanged user constraints.

| Example request | Suggested route |
| --- | --- |
| Read-only diagnosis of a crash; do not edit | Read-only evidence within the confirmed scope. |
| Fix using only the primary agent; do not delegate | No subagent route. |
| Implement a cross-module migration from an existing plan | Implementation and graph-assisted impact check, without replanning. |
| Find callers of the auth module | Code evidence using a direct read, graph query, or broader scan as appropriate to scope. |
| Inspect a patch for regressions | Review with graph and source verification where relevant. |
| Organize interview notes into a priority table, or make a UI prototype from an approved design | Deliverable execution, not duplicate planning. |
| Design a QA test plan | Planning; the tester has not begun executing cases. |
| Run existing cases without changing the product | Verification execution. |
| Research competitor pricing from official sources | External research with sources, dates, and fact/inference boundaries. |
| Review onboarding design or campaign channel dependencies | Review without code-graph rules. |
| Fix a spelling error in a README that happens to mention security | No high-risk escalation from the word “security.” |
| Fix a single-file permission defect | Primary agent checks the contract, evidence, and authority, then validates according to actual risk. |

Review takes precedence over incidental search terms. A request to produce a concrete deliverable remains execution even if it contains “design.” QA planning and executing established cases are separate routes. Code work may be divided into evidence, boundary decisions, implementation, validation, and necessary review. Low-cost labor handles logs, call/source evidence, and established tests; code writing defaults to the host-supported Sol candidate. Graph guidance applies only to explicit code structure, call relationships, or code review.

Roles, `workspace-write`, and routing hints grant no additional authority. The primary agent checks existing user authorization for external publishing or sending, purchases, production operations, and real-data changes. Code review normally excludes third-party implementation directories such as `3rd`, `third_party`, `third-party`, `thridpart`, and `vendor`; it checks first-party integration and necessary dependency interfaces. Do not format or lint third-party sources by default. Preserve include order and local clang-format guards when dependencies require them, and judge blockers by actual impact evidence.

Generated configuration does not prove host role loading or account model access. Before spawning, verify actual host support for the model/effort pair. Use a supported pair or primary-agent execution when a default is unavailable; do not silently replace a user-specified model. The plugin makes no model-probing requests. Profile files do not consume agent slots; spawned threads do. Stop threads after integration, a blocker, or loss of need.

## Shell compatibility and Git boundary

Node.js 18 or newer is required on Windows and macOS. Hooks run in Node.js independently of the integrated terminal shell. Command analysis recognizes `&&`, `||`, `;`, pipes, and redirection in macOS `zsh`/`bash` and Git Bash; PowerShell separators, pipes, common read-only cmdlets, and Windows executable suffixes; and forms without spaces such as `npm test&&rm -rf .` and `echo ok>file`. Changing the integrated terminal shell affects newly opened terminals, not hook execution.

Single Git CLI commands stay quiet and serial in the primary agent. This is an orchestration rule, not a Git permission for subagents. For explicitly requested complete local commit preparation, one designated writable agent in the same workspace may inspect status and diff, stage only target files, and report a summary, checks, HEAD and index-tree OIDs, and a commit message. It cannot commit, perform remote operations, or rewrite history. The primary agent must not run Git concurrently; after handoff it verifies status, diff, staging scope, and OIDs before committing. No extra role or configuration switch is needed.

Compound commands are analyzed by segment. A Git segment does not hide a later non-Git state change: `git status && rg -n TODO src` and `git status && rm -rf .` both continue analysis after Git. Do not put `git` in `shell_heads` as an “authorization” mechanism. Legacy `git_readonly_*` and `git_safe_write_*` keys do not control this version. Nested evaluation such as `git status $(other-command)`, PowerShell script blocks, process substitution, block comments, and ambiguous cross-shell escaping are not classified as pure Git CLI. These rules never bypass the Codex sandbox, user authority, hook trust, or Git protections.

## CodeMap Boost, Context Mode, and Serena

The default lightweight MCP prefixes include CodeMap Boost, Context Mode, and Serena, including Codex-native and plugin-namespaced Context Mode names and common Serena server names. Their tools can be used directly without a false “must delegate” hint. Agent Dispatch selects agents; CodeMap Boost owns graph refresh, read barriers, and graph retrieval. Use graph rules only for explicit code structure, call relationships, impact, or code review. Verify relationships against source and never claim an unrun query produced evidence.

Agent Dispatch does not install these MCPs. Context Mode is a separate Codex plugin; Serena needs its own setup. Additional server prefixes can be configured with `mcp_prefixes_add`. CodeMap tools may be deferred and absent from static schemas; inspect `ALL_TOOLS` for `mcp__code_review_graph__*` or make an appropriate call before declaring them unavailable.

## Agent profiles and model selection

For a Git project, `SessionStart` generates local `.codex/agents/*.toml` profiles with independent `model`, `model_reasoning_effort`, and `sandbox_mode` fields.

| Agent | Default model | Effort | Purpose |
| --- | --- | --- | --- |
| `dispatch_explorer` | `gpt-6-luna` | `medium` | Bounded read-only search and evidence; code graph only for explicit structure questions. |
| `dispatch_mapper` | `gpt-6-luna` | `medium` | Broad read-only scans and relationship mapping across materials. |
| `dispatch_researcher` | `gpt-6-luna` | `medium` | Official sources, current facts, market/competitor and version-sensitive research. |
| `dispatch_luna_worker` | `gpt-6-luna` | `max` | Low-cost search, source/log evidence, material organization, and established tests; may write evidence artifacts but not product/test code. |
| `dispatch_sol_worker` | preferably `gpt-6.1-sol` | `high` | Default code implementation and tests; compatibility fallback `gpt-6-sol/medium`. |
| `dispatch_astra_worker` | `gpt-6-astra` | `medium` | Optional candidate for exceptionally complex deliverables when its cost is justified. |
| `dispatch_worker` | explicit at spawn | explicit at spawn | Unpinned general execution role. |
| `dispatch_hard_worker` | explicit at spawn | explicit at spawn | Unpinned role for difficult deliverables and complex problems. |
| `dispatch_tester` | `gpt-6-luna` | `medium` | Verification against established cases, criteria, or reproduction steps without changing the deliverable. |
| `dispatch_planner` | preferably `gpt-6.1-sol` | `high` | Plans and constraint analysis; fallback `gpt-6-sol/high`. |
| `dispatch_reviewer` | preferably `gpt-6.1-sol` | `high` | Ordinary independent review; fallback `gpt-6-sol/high`. |
| `dispatch_deep_reviewer` | `gpt-6-astra` | `high` | Critical acceptance or exceptionally complex constraints, not risk-keyword escalation. |

These are overridable presets, not account availability guarantees. Choose model and effort together for the actual responsibility, user preference, host support, and total task cost. Low-cost `policy.low_cost` defaults to `gpt-6-luna/max`; other Luna evidence roles remain at `medium`. Evidence gathering and established tests differ from judging correctness or acceptance. A mixed “logs + fix” task gives Luna only the evidence stage. Use the effective `dispatch_sol_worker` for code writing, or an enabled unpinned non-Luna worker with an explicit pair, or primary-agent execution.

Each profile and `policy.low_cost` may specify an ordered `model_candidates` array of `{ model, model_reasoning_effort }` pairs. After merging configuration, the plugin reads only `${CODEX_HOME}/models_cache.json` (or `~/.codex/models_cache.json`) and chooses the first pair listed in a catalog no more than 24 hours old. Missing, damaged, stale, or unmatched catalogs leave the configured baseline intact. The catalog is a compatibility hint, not proof of account access or loaded roles; hooks do not make network or model-probe requests. An explicit override of `model` or `model_reasoning_effort`, including an empty string, clears inherited candidates unless that layer also supplies `model_candidates`. Use `[]` to disable selection. Candidate resolution occurs before TOML generation; a newly opened task loads a changed profile.

The capability snapshot used for static validation was checked against the Codex host catalog on 2026-10-08. It detects obviously incompatible pairs but does not probe account access:

| Model | Recorded effort levels |
| --- | --- |
| `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-6-luna` | `low`, `medium`, `high`, `xhigh`, `max`; no `ultra` |

Thus `gpt-6-luna/max` and `gpt-6-astra/ultra` are valid recorded pairs, while Luna/ultra is not. For a temporary Astra/ultra task, use an unpinned `dispatch_worker` or `dispatch_hard_worker`, pass both model and effort explicitly, and verify actual host support and need. Pinned TOML values override spawn arguments. The current host's full-history fork cannot accept model overrides; pass only the necessary context using a supported path. The primary conversation model is controlled by Codex settings, not this plugin. Generated profile paths are added individually to `.git/info/exclude`; hand-written, tracked, empty, or symlinked files are preserved. Only untracked profiles carrying the plugin's managed header can be updated or cleaned up.

Substantive deliverables receive proportionate validation and then independent review. Code may need tests, builds, or runtime evidence; design, documents, operations, and data use their own content, format, constraint, and data checks. The primary agent verifies substantive findings, reuses the original writer for a bounded fix, reruns affected checks, and reviews again. User limits on delegation or concurrency prevail; primary-only review should state its actual scope.

For every new or reused review agent, choose a supported pair from enabled reviewer candidates based on responsibility, ambiguity, risk, quality needs, explicit user settings, and total cost. Reassess after scope or risk changes. Before spawning, verify host support and actual role loading; a task name does not prove the model. Before accepting the conclusion, check observable host model/effort metadata and mark it unconfirmed if unavailable. Messaging an existing Luna agent cannot switch it to Astra. Evidence collection or passing tests do not themselves constitute independent review. Hooks supply `additionalContext` guidance, not a hard interceptor of `spawn_agent` arguments. A reviewer checks task intent, acceptance criteria, real entry points, and use paths; only concrete defects affecting current acceptance block. For code, preserve debug-only branches such as `#if DEBUG`, `#ifdef _DEBUG`, `#if DBG`, and `KdBreakPoint()` unless evidence shows impact on the requested release or runtime path.

The default concurrency limit is three spawned subagents, not three profile files. Pass each subagent only the objective, owned files, needed evidence, and acceptance criteria; return a summary and relevant log paths. Stop agents after integration. Do not hand-edit generated TOML or create unrelated `~/.codex/agents/luna-worker.toml` profiles for this plugin; override its three JSON layers instead.

## Configuration

Configuration merges three layers in order: `defaults/dispatch-rules.json`, global `PLUGIN_DATA/config.json`, and project `<git-root>/.agent-dispatch-codex/config.json`. The project configuration directory is added to `.git/info/exclude`; the plugin does not edit `.gitignore`. An override file can contain only changed fields:

```json
{
  "schema_version": 1,
  "modules": { "pre_tool_nudge": false },
  "policy": {
    "max_parallel_subagents": 2,
    "low_cost": { "enabled": true, "model": "gpt-6-luna", "model_reasoning_effort": "max" }
  },
  "agent_profiles": {
    "profiles": {
      "dispatch_worker": { "model": "", "model_reasoning_effort": "" },
      "dispatch_reviewer": { "enabled": false }
    }
  },
  "overrides": {
    "shell_heads_add": ["my-local-tool"],
    "mcp_prefixes_add": ["mcp__my_local_"]
  }
}
```

Policy fields include `max_parallel_subagents`, `require_changed_file_report`, `require_validation_report`, and `low_cost.{enabled,model,model_reasoning_effort}`. List overrides apply only to `mcp_prefixes_*`, `shell_heads_*`, and `prompt_keywords_*`. Legacy `git_readonly_*` and `git_safe_write_*` keys cannot change the primary agent's serial Git rule.

Explicit `model` and `model_reasoning_effort` values in the same layer are preserved, including empty strings. An empty string omits that TOML field so the host inherits it. Clearing only `model` without supplying effort clears both. Switching only to a different known model uses this plugin's conservative `medium` preset rather than inheriting an old or primary `ultra`; for an unknown model, effort is omitted and host support must be checked. Description-only edits or repeating the same model retain inherited effort, while an explicit effort in a closer layer wins. `policy.low_cost` also merges across layers and must resolve to an available pinned role or an explicitly configured unpinned `dispatch_worker`, never silently to the primary model.

Disabling a profile or all profiles cleans up corresponding untracked managed files on the next `SessionStart`, including obsolete managed roles. Hand-written, tracked, and symlinked files remain owned by their creators. Existing tasks do not unload already loaded roles; open a new task to inspect the final set. The `agent-dispatch-setup` skill can show effective rules and their three sources.

## Sources and verification

The [OpenAI model selection guidance](https://learn.chatgpt.com/docs/models), checked on 2026-09-07, informed the role split: Luna for clear repetitive tasks, Terra for daily work, Sol for complex open-ended work, and Astra for the hardest end-to-end work. The specific effort presets are overridable starting points, not benchmarked savings claims. [Official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) describes TOML, model precedence, and thread control. The [Astra guide](https://developers.openai.com/api/docs/guides/latest-model) informs delegation boundaries and proportionate verification. The community [codex-astra-luna-orchestrator](https://github.com/donvito/codex-astra-luna-orchestrator) inspired bounded task division and concise evidence handoff; it is a workflow reference, not a model or cost benchmark.

Run `npm test` for local validation. After installing or updating, open a new Codex task and review and trust the current hook hash in `/hooks`.
