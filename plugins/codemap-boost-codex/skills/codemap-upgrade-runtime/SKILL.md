---
name: codemap-upgrade-runtime
description: Inspect or immediately check CodeMap Boost's managed CRG and Serena runtime updates, including weekly checks, candidate validation, and failed-update diagnosis. Use when the user asks about the underlying tools rather than the plugin source.
---

# CodeMap Runtime Updates

CRG and Serena check official stable releases automatically, at most once every seven days when the plugin is used. A healthy runtime keeps serving while a candidate is prepared in a separate version directory. Successful compatibility checks publish a version pointer for later launches. Failed checks retain the previous runtime and record the error.

## Inspect or check now

Resolve the installed plugin root from this skill or `codex plugin list --json`. Use the plugin's own update entry point:

```bash
node <plugin-root>/scripts/runtime-update.cjs --doctor
node <plugin-root>/scripts/runtime-update.cjs --check-now
```

1. Read the doctor output for effective versions, update timestamps, and failures. Doctor is read-only.
2. When the user requests an immediate check, run `--check-now`. Package installer success alone is insufficient: the updater must pass its runtime and integration checks before changing the active version.
3. Report each tool's outcome separately: already current, updated for later launches, failed with the old version retained, or disabled. Existing MCP processes keep their original environment; a new task loads the selected version.

The default update source is official PyPI. Serena's initial compatibility baseline is 1.7.0, not a permanent version ceiling. CRG candidates must pass parser and graph-refresh adapter checks; Serena candidates must preserve Codex MCP tooling and the disabled dashboard/browser/GUI behavior. Language-server capability still depends on the target project's language and build setup.

## Boundaries

- Keep venvs versioned and independent. Do not upgrade an active environment in place, move its directory, overlay a backup, or delete locked files.
- Do not modify PATH, user site-packages, project graphs/configuration, user MCP registrations, or CC Switch settings.
- `CODEMAP_BOOST_DISABLE_RUNTIME_UPDATES=1` explicitly disables automatic runtime updates; report this state instead of silently overriding it.
- Plugin source updates are separate: `scripts/plugin-update.cjs --doctor|--check-now` uses Codex's native update flow for the configured official codex-toolshop marketplace. Do not confuse a marketplace refresh with runtime validation.
- tgrep owns its release checks in `tgrep-search-codex`; use that plugin's doctor/update commands when investigating text-search version changes.
