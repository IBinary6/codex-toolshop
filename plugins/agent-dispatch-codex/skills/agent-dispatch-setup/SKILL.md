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

`role_kind: "verification"` marks verification-only work; `role_kind: "labor"` marks bounded evidence and material work. Both are excluded from deliverable-writing candidates. A labor profile may write assigned evidence artifacts, but it does not implement or modify product or test code. These values are plugin metadata and are not emitted as Codex TOML settings.

For a Git worktree, the `SessionStart` hook materializes enabled profiles as project-local `.codex/agents/<name>.toml` files. It does not extend profile generation to arbitrary working directories. A non-Git task can still receive the general coordination policy, but named custom roles are available only when the host has actually loaded them; plugin installation or a profile in defaults is not proof of loading. Use host-provided roles or the primary agent when named roles are unavailable. After changing a profile, open a new Codex task so the client reloads custom agents. Preserve handwritten or empty files, tracked files, and symlink entries even when they have a managed header. Disabling one profile or all profiles removes only untracked, non-symlink managed files; retired managed profiles absent from the effective configuration are also removed.

The setup skill is not an installation prerequisite. After the plugin is installed and enabled, `SessionStart` automatically creates missing configuration skeletons, merges the three layers, materializes managed profiles, and injects the coordinator policy. `UserPromptSubmit` adds a short candidate route for recognized tasks; keywords do not override scope, explicit user preferences, an existing plan, or the primary agent's delegation decision. Long text alone does not trigger routing. Use this skill only to inspect or customize the automatic defaults.

Treat every automatic route as a fallible suggestion from the current message, not a host restriction or persistent task state. Read-only detection looks for direct request clauses instead of arbitrary substrings in product behavior; it does not determine authorization. The primary agent must distinguish actual task instructions from product descriptions and quoted material, and infer the current stage from the full conversation and the latest explicit user request. A later turn with no routing hint does not keep an earlier route in force. Continue the authorized objective while retaining user constraints that have not changed. Keep unmatched continuation messages quiet; do not add a continuation phrase list or a session-stage lock.

## Model selection and review

Read the effective profiles and their descriptions before choosing a role. Select among evidence labor, planning, implementation, verification, research, and review by the bounded responsibility and expected evidence. Choose implementation candidates by ambiguity, context, acceptance difficulty, and total completion cost including rework.

With the defaults, code writing uses `dispatch_sol_worker` at Sol medium. If that profile is disabled or its fixed pair is overridden, use an enabled unpinned non-Luna writer with explicit Sol medium, or keep implementation in the primary agent. Terra, Astra, and the hard worker remain available when actual complexity or an explicit preference calls for them.

`policy.low_cost` defaults to `{"enabled": true, "model": "gpt-5.6-luna", "model_reasoning_effort": "max"}`. Use the matching labor profile for logs, routine materials, mechanical data, source/call evidence, and established test execution. It may create evidence artifacts but does not implement or modify product or test code. In mixed tasks, split only the evidence stage to labor. If no matching fixed profile exists, an enabled unpinned `dispatch_worker` may receive the supported low-cost pair explicitly; otherwise report the limitation rather than silently changing models.

For code work, use only the stages the task needs: labor evidence, primary-agent boundary decisions, Sol implementation by default, affected validation, and necessary independent review. Prompts such as generating code, updating source, or writing tests are implementation; isolated writing, organizing, or generating without a code artifact is not. QA planning, verification-only work, read-only and primary-only requests retain their earlier priority.

Complete local commit preparation does not add a role or configuration switch and does not fix a model. The primary agent or the explicit skill workflow selects the single writable candidate for the actual task; when the profile is unpinned, pass a supported model and effort explicitly.

For a non-trivial deliverable, require proportionate validation and an independent review using the effective reviewer profile. Choose evidence for the artifact: code may need tests or builds, while designs, documents, operational outputs, and data results need their own content, format, constraint, or source checks. Verify material findings, return bounded fixes to the original writer when useful, rerun affected checks, and re-review the result and impact. Respect primary-only requests, disabled roles and concurrency limits, and report the actual review scope. Give each agent minimal necessary context and artifact ownership; keep reviewer context independent from the writer's assumptions.

### Review model checks

Gathering locations, excerpts, or established test results is evidence work. Judging correctness, compatibility, defects, or delivery acceptance is review, including small regression checks, read-only checks, and follow-up reviews after a fix. Keep evidence and review conclusions distinct; small scope alone does not justify the `policy.low_cost` route. Keyword routing only provides hints: infer the actual responsibility from context, without relying on domain-specific terms or sentence patterns to choose a model.

For every new or reused review agent, including an automatic review after implementation:

1. Honor the user's existing explicit model and effort requirements. Otherwise autonomously choose a supported combination from effective enabled reviewer candidates based on ambiguity, risk, quality needs, and total completion cost. Reassess when scope or risk changes; do not fix all reviews to one model or the highest effort, or blindly retain the first selection.
2. Check host support and the actual loaded profile. Fixed TOML fields take precedence over spawn overrides. A generic spawn's `task_name` is a label, not a profile selector or runtime-model proof. When an enabled reviewer target exists but its named role is not loaded, use a host-supported generic spawn with the explicit review pair, or perform primary-agent review and state its scope. Honor primary-only requests and disabled review delegation by reviewing in the primary agent; unavailable roles do not justify switching review to the low-cost evidence pair.
3. Verify the existing model before reusing an agent. A follow-up message cannot by itself change the model. If it does not match, use a supported model-change operation and confirm its result, or create a new matching reviewer. Reuse the evidence, then obtain a fresh review conclusion under the required model.
4. Before accepting the conclusion, compare the target pair with host-observable runtime metadata. Requested arguments, task names, and the agent's self-report alone do not establish the actual model. If runtime metadata is unavailable, report it as unconfirmed. An interrupted review or an unconfirmed model must not be reported as a completed independent review with verified model identity. A subagent that detects a mismatch returns the limitation and any auxiliary evidence to the primary agent without claiming review approval or spawning a replacement itself.

The hooks transmit these checks through `additionalContext`; they do not implement a hard spawn interceptor or read private session databases. Passing routing tests proves the generated guidance, not enforcement by the host. Preserve this distinction when validating or describing model checks.

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
