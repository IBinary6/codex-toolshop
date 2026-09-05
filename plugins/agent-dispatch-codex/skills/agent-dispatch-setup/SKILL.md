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
- `agent_profiles.profiles.<name>.description`
- `agent_profiles.profiles.<name>.developer_instructions`

The `SessionStart` hook materializes enabled profiles as project-local `.codex/agents/<name>.toml` files. After changing a profile, open a new Codex task so the client reloads custom agents. Preserve handwritten or empty files, tracked files, and symlink entries even when they have a managed header. Disabling one profile or all profiles removes only untracked, non-symlink managed files; retired managed profiles absent from the effective configuration are also removed.

The setup skill is not an installation prerequisite. After the plugin is installed and enabled, `SessionStart` automatically creates missing configuration skeletons, merges the three layers, materializes managed profiles, and injects the coordinator policy. `UserPromptSubmit` adds a short candidate route for recognized tasks; keywords do not override scope, explicit user preferences, an existing plan, or the primary agent's delegation decision. Long text alone does not trigger routing. Use this skill only to inspect or customize the automatic defaults.

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
- The plugin does not change the primary conversation model. It creates narrow project agents for bounded search, broad mapping, planning analysis, routine development, difficult execution, and review. Writable roles inherit the primary task model by default; all roles honor task context, host availability, and explicit user preference. The primary agent owns final decisions and normal acceptance. Do not require a new planner and reviewer for every task or overwrite an actionable plan with a keyword-driven workflow.
- A generated profile does not consume a runtime slot. Only a spawned agent thread does. Stop or close active/completed threads as soon as their result is integrated.
- After Hook definitions change, the user must open a new task and trust the new Hook hash in `/hooks`.
