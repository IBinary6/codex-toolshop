---
name: agent-dispatch-setup
description: Configure or explain Agent Dispatch for Codex, including layered policy, per-agent model profiles, shell and MCP lightweight lists, project overrides, and subagent reporting behavior.
---

# Agent Dispatch setup

Use this skill when the user asks to inspect, explain, enable, disable, or customize `agent-dispatch-codex`.

## Configuration layers

Read and merge these sources in order:

1. `${PLUGIN_ROOT}/defaults/dispatch-rules.json`
2. `${PLUGIN_DATA}/config.json`
3. `<git-root>/.agent-dispatch-codex/config.json`

The project layer wins. Overrides use add/remove arrays instead of copying the complete defaults.

All Git commands are an invariant rather than a configurable whitelist: the primary agent runs them one at a time, never delegates them, and never parallelizes Git operations.

Agent lifecycle is also an invariant: after the primary agent integrates a subagent result, or the subagent is blocked or no longer needed, stop it promptly so idle agents do not occupy limited runtime slots.

## Workflow

1. Resolve the current Git root with `git rev-parse --show-toplevel`.
2. Read every existing layer and show the effective values with their source.
3. Ask which layer to change only when the user's request does not already make it clear.
4. Change only the requested keys. Preserve unknown keys and existing user overrides.
5. Validate the resulting JSON and summarize the effective behavior.

Supported module switches:

- `modules.session_guidance`
- `modules.prompt_guidance`
- `modules.pre_tool_nudge` (disabled by default)
- `modules.subagent_guidance`

Supported policy values:

- `policy.max_parallel_subagents`
- `policy.require_changed_file_report`
- `policy.require_validation_report`

Supported custom-agent values:

- `agent_profiles.enabled`
- `agent_profiles.profiles.<name>.enabled`
- `agent_profiles.profiles.<name>.model`
- `agent_profiles.profiles.<name>.model_reasoning_effort`
- `agent_profiles.profiles.<name>.sandbox_mode`
- `agent_profiles.profiles.<name>.role_kind`
- `agent_profiles.profiles.<name>.description`
- `agent_profiles.profiles.<name>.developer_instructions`

`role_kind: "verification"` marks a test-only profile: its workspace-write permission allows test artifacts, but it is not a code-writing candidate. This is plugin metadata and is not emitted as a Codex TOML setting. Profiles without this value retain the existing workspace-write candidate behavior.

The `SessionStart` hook materializes enabled profiles as project-local `.codex/agents/<name>.toml` files. After changing a profile, open a new Codex task so the client reloads custom agents. Preserve handwritten or empty files, tracked files, and symlink entries even when they have a managed header. Disabling one profile or all profiles removes only untracked, non-symlink managed files; retired managed profiles absent from the effective configuration are also removed.

The setup skill is not an installation prerequisite. After the plugin is installed and enabled, `SessionStart` automatically creates missing configuration skeletons, merges the three layers, materializes managed profiles, and injects the coordinator policy. `UserPromptSubmit` adds a short candidate route for recognized tasks; keywords do not override scope, explicit user preferences, an existing plan, or the primary agent's delegation decision. Long text alone does not trigger routing. Use this skill only to inspect or customize the automatic defaults.

## Model selection and review

Read the effective profiles and their descriptions before choosing a role. Retrieval and repetitive evidence collection use lightweight candidates. Execution candidates cover bounded repetitive work, balanced everyday implementation, and complex constraints; choose by ambiguity, context, acceptance difficulty, and total completion cost including rework. A high-ambiguity task can start with a stronger model. More reasoning is not automatically more economical, and reasoning levels are not equivalent across models.

With the default profiles, prefer Sol medium for complex code and substantial refactoring with clear requirements; consider Astra medium for difficult cross-module implementation or refactoring with interacting constraints and sustained reasoning needs. Mechanical refactoring can use a lighter writer. Preserve behavior and contracts unless changes are authorized; the primary agent still owns architecture and contract decisions, and execution by Astra does not replace independent review.

For a non-trivial implementation, require focused writer validation and an independent review using the effective reviewer profile. Verify material findings, return bounded fixes to the original writer when useful, rerun affected checks, and re-review the changes and their impact. Repeated findings without new evidence require a changed task split, model, or primary-agent intervention; do not loop on cosmetic preferences. Respect primary-only requests, disabled roles and concurrency limits, and report the actual review scope. Give each agent minimal necessary context and file ownership; keep reviewer context independent from the writer's assumptions.

Review against the actual task intent, build configuration, entry points and caller contracts. Block only on concrete defects shown to affect the current acceptance target; missing context, hypothetical concurrency and style preferences are advisory. Preserve intentional debug-only branches and instrumentation (for example `#if DEBUG`, `#ifdef _DEBUG`, `#if DBG`, `KdBreakPoint()`); users may choose whether to act on an advisory, without pausing authorized work. Treat them as defects only with evidence of impact on the required delivery/runtime configuration. Advisory findings must not trigger automatic rewrites or removal of user debugging code.

An explicit custom-agent TOML `model` or `model_reasoning_effort` wins over spawn arguments. For a temporary different pair, use the unpinned `dispatch_worker` / `dispatch_hard_worker` and explicitly pass both values; omitted values can inherit expensive parent settings. Honor the host's fork rules: a full-history fork may not accept model overrides, so use a bounded context handoff where required. Profiles increase available choices, not the number of agents that must run; maintain the configured concurrency limit.

When validating routing, include constraints as well as positive keywords: “只读诊断崩溃” must not suggest a writer; “只用主代理” must not suggest delegation; an existing implementation plan must not select a new planner. Dependency/caller queries should suggest graph-first search, patch regression checks should suggest review, and wording-only document reviews must not escalate merely because they quote “security”. A one-file permission fix stays with the primary agent and retains proportionate risk checks. These are heuristic suggestions, never a substitute for the full user instructions or authorization.

Supported list overrides:

- `mcp_prefixes_add` / `mcp_prefixes_remove`
- `shell_heads_add` / `shell_heads_remove`
- `prompt_keywords_add` / `prompt_keywords_remove`

## Important boundaries

- Codex `PreToolUse` may include `agent_id`; absence is not proof of primary-agent origin. The nudge is disabled by default; when explicitly enabled, keep ordinary Bash calls silent and do not convert the remaining soft nudge into a blanket deny rule.
- Git commands bypass Agent Dispatch classification, including destructive Git subcommands. This is an orchestration rule only; it does not replace the Codex sandbox, user authorization, Hook trust, or Git safety checks.
- Continue classifying non-Git segments in a compound shell command even when another segment is Git.
- Nested evaluation or ambiguous shell syntax is not proof of a pure Git operation. It does not itself request delegation or add authorization; keep task routing at the prompt level and preserve ordinary tool checks.
- Default lightweight MCP prefixes include CodeMap Boost, Context Mode (canonical and plugin-namespaced forms), and Serena (`serena` and `serena-cross-platform`). These integrations remain separately installed and enabled.
- When CodeMap Boost is installed, Agent Dispatch owns role selection while CodeMap Boost owns graph refresh, read barriers, and retrieval guidance. Search agents should prefer its graph tools and must not start a duplicate build/update. CodeMap MCP tools may be deferred and absent from static or top-level schemas; before claiming they are unavailable, inspect `ALL_TOOLS` for `mcp__code_review_graph__*` when available or make an actual call, rather than relying on the top-level list alone.
- The integrated terminal can be Git Bash while the Windows Codex agent uses PowerShell. Keep configuration entries as executable heads, not shell-specific command strings.
- Project configuration is excluded through `.git/info/exclude`; do not edit the project's tracked `.gitignore` unless the user explicitly asks.
- Generated custom-agent files are excluded individually through `.git/info/exclude`. Do not exclude the whole `.codex/` directory.
- Explicit `model` and `model_reasoning_effort` values, including empty strings, take precedence. Changing only `model` resets the prior model's effort: known models use the plugin's `medium` preset, while an unknown or empty model omits effort. Repeating the same model or changing unrelated fields preserves the previous effort. The known capabilities in `config.js` are a dated host snapshot, not proof of account availability.
- Check the actual host-supported model/effort pair before spawning any role. Session guidance reports known incompatible combinations and unknown models without changing explicit configuration or mapping to another model. An explicitly empty effort inherits from the parent and still needs compatibility checking when the model is fixed; do not blindly inherit `ultra` into a model without that level.
- The plugin does not change the primary conversation model. It creates project agents for search, mapping, research, execution, verification, planning and review. Fixed execution profiles are alternatives; unpinned worker profiles support explicit per-task model selection. The primary agent owns final decisions and acceptance. Use independent review for non-trivial implementation, while small tasks stay proportionate and existing plans stay actionable.
- A generated profile does not consume a runtime slot. Only a spawned agent thread does. Stop or close active/completed threads as soon as their result is integrated.
- After Hook definitions change, the user must open a new task and trust the new Hook hash in `/hooks`.
