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

The `SessionStart` hook materializes enabled profiles as project-local `.codex/agents/<name>.toml` files. After changing a profile, open a new Codex task so the client reloads custom agents. Preserve any same-name file that does not carry the plugin-managed header.

The setup skill is not an installation prerequisite. After the plugin is installed and enabled, `SessionStart` automatically creates missing configuration skeletons, merges the three layers, materializes managed profiles, and injects the coordinator policy. `UserPromptSubmit` automatically adds a short task-specific route when a prompt needs delegation. Use this skill only to inspect or customize the automatic defaults.

Supported list overrides:

- `mcp_prefixes_add` / `mcp_prefixes_remove`
- `shell_heads_add` / `shell_heads_remove`
- `prompt_keywords_add` / `prompt_keywords_remove`

## Important boundaries

- Codex `PreToolUse` cannot reliably identify whether a Bash, `apply_patch`, or MCP call came from the primary agent or a subagent. The nudge is disabled by default; when explicitly enabled, keep ordinary Bash calls silent and do not convert the remaining soft nudge into a blanket deny rule.
- Git commands bypass Agent Dispatch classification, including destructive Git subcommands. This is an orchestration rule only; it does not replace the Codex sandbox, user authorization, Hook trust, or Git safety checks.
- Continue classifying non-Git segments in a compound shell command even when another segment is Git.
- Nested shell evaluation, process substitution, script blocks, block comments, and cross-shell ambiguous escapes are not Git CLI operations and continue to require dispatch review even when the outer segment starts with `git`.
- Default lightweight MCP prefixes include CodeMap Boost, Context Mode (canonical and plugin-namespaced forms), and Serena (`serena` and `serena-cross-platform`). These integrations remain separately installed and enabled.
- When CodeMap Boost is installed, Agent Dispatch owns role selection while CodeMap Boost owns graph refresh, read barriers, and retrieval guidance. Search agents should prefer its graph tools and must not start a duplicate build/update. CodeMap MCP tools may be deferred and absent from static or top-level schemas; before claiming they are unavailable, inspect `ALL_TOOLS` for `mcp__code_review_graph__*` when available or make an actual call, rather than relying on the top-level list alone.
- The integrated terminal can be Git Bash while the Windows Codex agent uses PowerShell. Keep configuration entries as executable heads, not shell-specific command strings.
- Project configuration is excluded through `.git/info/exclude`; do not edit the project's tracked `.gitignore` unless the user explicitly asks.
- Generated custom-agent files are excluded individually through `.git/info/exclude`. Do not exclude the whole `.codex/` directory.
- An empty `model` omits the field so the child inherits the parent choice. Model availability is still controlled by the user's account and workspace policy.
- The plugin does not change the primary conversation model. It creates narrow project agents for bounded search, broad mapping, non-trivial planning, routine development, difficult execution, normal review, and high-risk review. Search, planning, and review keep their specialized boundaries; writable roles inherit the primary task model by default, and the primary agent chooses their role, model, and reasoning strength from task complexity, context, risk, availability, and explicit user preference. Do not force all coding through one writer profile or a fixed Luna/max or Terra/ultra tier.
- A generated profile does not consume a runtime slot. Only a spawned agent thread does. Stop or close active/completed threads as soon as their result is integrated.
- After Hook definitions change, the user must open a new task and trust the new Hook hash in `/hooks`.
