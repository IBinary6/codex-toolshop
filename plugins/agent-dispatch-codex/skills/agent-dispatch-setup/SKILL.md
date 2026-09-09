---
name: agent-dispatch-setup
description: Configure or explain general-purpose Agent Dispatch for Codex, including layered policy, task routes, per-agent model profiles, project overrides, and subagent reporting behavior.
---

# Agent Dispatch setup

Use this skill when the user asks to inspect, explain, enable, disable, or customize `agent-dispatch-codex`.

## Configuration layers

Read and merge these sources in order:

1. `${PLUGIN_ROOT}/defaults/dispatch-rules.json`
2. `${PLUGIN_DATA}/config.json`
3. `<git-root>/.agent-dispatch-codex/config.json`

The project layer wins. Overrides use add/remove arrays instead of copying the complete defaults.

Ordinary single-command Git CLI stays quiet independently of `pre_tool_nudge` and is run serially by the primary agent. The only semantic exception is an explicitly delegated complete local commit-preparation workflow: when the user request or an explicit skill workflow calls for it, the primary agent may designate one writable agent in the same workspace to inspect status, read the diff, and precisely stage target files, then return a summary, checks, HEAD/index tree OIDs, and a commit message. The preparer never commits, pushes, or rewrites history; the primary agent does not operate Git concurrently, validates the snapshot, and completes the commit. This is orchestration guidance, not a configurable Git whitelist or a replacement for sandbox and authorization checks.

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
- `policy.low_cost.enabled`
- `policy.low_cost.model`
- `policy.low_cost.model_reasoning_effort`

Supported custom-agent values:

- `agent_profiles.enabled`
- `agent_profiles.profiles.<name>.enabled`
- `agent_profiles.profiles.<name>.model`
- `agent_profiles.profiles.<name>.model_reasoning_effort`
- `agent_profiles.profiles.<name>.sandbox_mode`
- `agent_profiles.profiles.<name>.role_kind`
- `agent_profiles.profiles.<name>.description`
- `agent_profiles.profiles.<name>.developer_instructions`

`role_kind: "verification"` marks a verification-only profile. Its workspace-write permission allows evidence artifacts from an established QA, acceptance, test, or reproduction plan, but it is not a deliverable-writing candidate and must not modify the item under verification unless that scope is explicitly assigned. This is plugin metadata and is not emitted as a Codex TOML setting. Profiles without this value retain the existing workspace-write candidate behavior.

For a Git worktree, the `SessionStart` hook materializes enabled profiles as project-local `.codex/agents/<name>.toml` files. It does not extend profile generation to arbitrary working directories. A non-Git task can still receive the general coordination policy, but named custom roles are available only when the host has actually loaded them; plugin installation or a profile in defaults is not proof of loading. Use host-provided roles or the primary agent when named roles are unavailable. After changing a profile, open a new Codex task so the client reloads custom agents. Preserve handwritten or empty files, tracked files, and symlink entries even when they have a managed header. Disabling one profile or all profiles removes only untracked, non-symlink managed files; retired managed profiles absent from the effective configuration are also removed.

The setup skill is not an installation prerequisite. After the plugin is installed and enabled, `SessionStart` automatically creates missing configuration skeletons, merges the three layers, materializes managed profiles, and injects the coordinator policy. `UserPromptSubmit` adds a short candidate route for recognized tasks; keywords do not override scope, explicit user preferences, an existing plan, or the primary agent's delegation decision. Long text alone does not trigger routing. Use this skill only to inspect or customize the automatic defaults.

## Model selection and review

Read the effective profiles and their descriptions before choosing a role. Select among investigation, planning, execution, verification, research, and review by the bounded task and expected evidence. Execution candidates cover repetitive deliverables, balanced everyday work, and difficult interacting constraints; choose by ambiguity, context, acceptance difficulty, and total completion cost including rework. A high-ambiguity task can start with a stronger model. More reasoning is not automatically more economical, and reasoning levels are not equivalent across models.

With the default profiles, consider Sol medium for clearly specified complex deliverables and Astra medium for difficult multi-part execution with interacting constraints and sustained reasoning needs. `policy.low_cost` defaults to `{"enabled": true, "model": "gpt-5.6-luna", "model_reasoning_effort": "max"}` and follows the same three-layer merge. When enabled, use the effective low-cost pair for delegated log retrieval, routine document read/write, mechanical data processing, source evidence, and execution of an established test plan. Keep read and evidence tasks read-only; a profile's workspace-write capability does not authorize changes. Reuse a profile only when its effective `model` and `model_reasoning_effort` both match; the default matching profile is `dispatch_luna_worker`. If no fixed profile matches, use the unpinned `dispatch_worker` only when it is enabled, loaded by the host, and its effective model and effort fields are unfixed, then pass an explicitly supported pair. A role name or an override applied to a fixed TOML does not establish a match. If no compliant role is available or the host cannot support the pair, report the limitation, narrow the task, or wait for an available low-cost route; do not silently fall back to a more expensive model. The primary agent still owns key plan and public-contract decisions, and execution by Astra does not replace independent review.

For code work, use the stages that the task needs: evidence, primary-agent boundary and contract decisions, bounded implementation, affected regression validation, and necessary independent code review. Separate evidence or mechanical work from complex implementation in mixed tasks; do not force every task through the full chain. Short locating or decision reads and small edits may stay with the primary agent, while long logs and batch documents default to the low-cost route. QA planning, product work, and explicit primary-only preferences retain their existing routes.

Complete local commit preparation does not add a role or configuration switch and does not fix a model. The primary agent or the explicit skill workflow selects the single writable candidate for the actual task; when the profile is unpinned, pass a supported model and effort explicitly.

For a non-trivial deliverable, require proportionate validation and an independent review using the effective reviewer profile. Choose evidence for the artifact: code may need tests or builds, while designs, documents, operational outputs, and data results need their own content, format, constraint, or source checks. Verify material findings, return bounded fixes to the original writer when useful, rerun affected checks, and re-review the result and impact. Respect primary-only requests, disabled roles and concurrency limits, and report the actual review scope. Give each agent minimal necessary context and artifact ownership; keep reviewer context independent from the writer's assumptions.

Review against the actual task intent, acceptance criteria, entry points, and use path. Block only on concrete defects shown to affect the current acceptance target; missing context, hypothetical risks, and style preferences are advisory. For code review, additionally verify build configuration and caller contracts, preserve intentional debug-only branches and instrumentation (for example `#if DEBUG`, `#ifdef _DEBUG`, `#if DBG`, `KdBreakPoint()`), and apply third-party and formatting boundaries below. Treat debug artifacts as defects only with evidence of impact on the required delivery/runtime configuration.

An explicit custom-agent TOML `model` or `model_reasoning_effort` wins over spawn arguments. For a temporary different pair, use the unpinned `dispatch_worker` / `dispatch_hard_worker` and explicitly pass both values; omitted values can inherit expensive parent settings. Honor the host's fork rules: a full-history fork may not accept model overrides, so use a bounded context handoff where required. Profiles increase available choices, not the number of agents that must run; maintain the configured concurrency limit.

When validating routing, include constraints and conflicting intent, not just positive keywords. A read-only difficult task may use a read-only evidence route; its read and evidence scope does not authorize changes. A primary-only request must not suggest delegation; an approved plan with a requested deliverable must select execution instead of planning. Creating a QA plan selects planning, while running approved cases selects verification and must not modify the deliverable. External-source research selects the researcher. Product or content production selects execution. Ordinary design reviews and business dependencies must not trigger code-graph guidance; only explicit code structure, caller, or code-review work does. These are heuristic suggestions, never a substitute for the full user instructions or authorization.

Supported list overrides:

- `mcp_prefixes_add` / `mcp_prefixes_remove`
- `shell_heads_add` / `shell_heads_remove`
- `prompt_keywords_add` / `prompt_keywords_remove`

## Important boundaries

- A role, `workspace-write`, profile loading, or routing suggestion does not create authority for external publishing or sending, purchases, production operations, or changes to real data. Read the current user and primary-agent authorization before those actions.

- For code work only, exclude vendored implementations under directory segments such as `3rd`, `3rdparty`, `third_party`, `third-party`, `thirdpart`, `thridpart`, `thridparty`, `vendor`, `external`, `deps`, and `packages` unless the user explicitly includes them. Review first-party integration and caller contracts; read dependency interfaces only as needed. Do not initiate dependency-wide review, formatting or cpplint. Preserve local clang-format protection for dependency-sensitive includes.

- Codex `PreToolUse` may include `agent_id`; absence is not proof of primary-agent origin. The nudge is disabled by default; when explicitly enabled, keep ordinary Bash calls silent and do not convert the remaining soft nudge into a blanket deny rule.
- Ordinary Git CLI bypasses single-command Agent Dispatch routing, including destructive Git subcommands, so a normal Git command remains quiet. This does not itself grant a subagent Git authority: only the explicit complete local commit-preparation handoff above permits one designated writable agent to prepare the local index. Final commit, remote operations, and history rewrites remain with the primary agent. This is an orchestration rule only; it does not replace the Codex sandbox, user authorization, Hook trust, or Git safety checks.
- Continue classifying non-Git segments in a compound shell command even when another segment is Git.
- Nested evaluation or ambiguous shell syntax is not proof of a pure Git operation. It does not itself request delegation or add authorization; keep task routing at the prompt level and preserve ordinary tool checks.
- Default lightweight MCP prefixes include CodeMap Boost, Context Mode (canonical and plugin-namespaced forms), and Serena (`serena` and `serena-cross-platform`). These integrations remain separately installed and enabled.
- When CodeMap Boost is installed, Agent Dispatch owns role selection while CodeMap Boost owns graph refresh, read barriers, and retrieval guidance. Use its graph guidance only for explicit code structure, call relationships, impact, or code-review context; ordinary design reviews and business dependencies stay on their normal evidence route. Code search agents must not start a duplicate build/update. CodeMap MCP tools may be deferred and absent from static or top-level schemas; before claiming they are unavailable, inspect `ALL_TOOLS` for `mcp__code_review_graph__*` when available or make an actual call, rather than relying on the top-level list alone.
- The integrated terminal can be Git Bash while the Windows Codex agent uses PowerShell. Keep configuration entries as executable heads, not shell-specific command strings.
- Project configuration is excluded through `.git/info/exclude`; do not edit the project's tracked `.gitignore` unless the user explicitly asks.
- Generated custom-agent files are excluded individually through `.git/info/exclude`. Do not exclude the whole `.codex/` directory.
- Explicit `model` and `model_reasoning_effort` values, including empty strings, take precedence. Changing only `model` resets the prior model's effort: known models use the plugin's `medium` preset, while an unknown or empty model omits effort. Repeating the same model or changing unrelated fields preserves the previous effort. The known capabilities in `config.js` are a dated host snapshot, not proof of account availability.
- Check the actual host-supported model/effort pair before spawning any role. Session guidance reports known incompatible combinations and unknown models without changing explicit configuration or mapping to another model. An explicitly empty effort inherits from the parent and still needs compatibility checking when the model is fixed; do not blindly inherit `ultra` into a model without that level.
- The plugin does not change the primary conversation model. In Git worktrees it creates project agents for search, mapping, research, execution, verification, planning and review. Fixed execution profiles are alternatives; unpinned worker profiles support explicit per-task model selection. The primary agent owns final decisions and acceptance. Use independent review for non-trivial deliverables, while small tasks stay proportionate and existing plans stay actionable.
- A generated profile does not consume a runtime slot. Only a spawned agent thread does. Stop or close active/completed threads as soon as their result is integrated.
- After Hook definitions change, the user must open a new task and trust the new Hook hash in `/hooks`.
