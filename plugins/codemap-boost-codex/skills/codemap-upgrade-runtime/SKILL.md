---
name: codemap-upgrade-runtime
description: Upgrade only the code-review-graph dependency inside CodeMap Boost's private runtime. Use when the user explicitly asks to update the underlying CRG service without upgrading or changing codemap-boost-codex itself.
---

# Upgrade CodeMap Runtime

Upgrade only the plugin-managed `code-review-graph[all]` package. Do not change the CodeMap Boost plugin version or source, and do not run upstream `code-review-graph install`.

## Boundaries

- Resolve the installed plugin root from this skill location or `codex plugin list --json`; never hardcode a plugin version.
- Resolve the marketplace-qualified plugin data directory through the plugin doctor. The target must be its `crg-runtime` child.
- Do not modify PATH, user site-packages, MCP registrations, `AGENTS.md`, `.gitignore`, project graphs, or cc-switch configuration.
- Never remove a same-name global `uvx code-review-graph serve` registration. Report it separately because only the user can confirm its ownership.
- Use `uv pip --python` against the private runtime. Never use `pip install --user`, `python -m pip`, or a global Python environment.

## Workflow

1. Run `node <plugin-root>/scripts/setup.cjs --doctor` from the current Git repository and record the private runtime path and health.
2. Read the current private version from `<runtime>/Scripts/code-review-graph.exe --version` on Windows or `<runtime>/bin/code-review-graph --version` elsewhere.
3. Query the published PyPI version. If it equals the private version, stop without modifying anything and report that the runtime is current.
4. Check whether the private runtime or any child process from it is currently serving this task. Do not kill processes. If backup, upgrade, or rollback reports sharing violation, access denied, or any locked path, stop immediately; do not retry deletion or fall back to an overlay copy. Report the stage and locked path, then give the user the exact command to run after fully exiting Codex.
5. Before mutation, resolve canonical paths and reject a runtime, parent, or backup path that traverses a symlink, junction, or Windows reparse point. Create a uniquely named sibling backup only when that destination does not already exist, and verify the canonical source and backup are different children of the same plugin data directory.
6. Upgrade only the private environment:

   ```text
   uv pip install --python <runtime-python> --upgrade --refresh code-review-graph[all]
   ```

7. Verify the upgraded CLI version, then rerun doctor. The private runtime check must pass, including Python, JavaScript, TypeScript, and TSX parser probes. A separately reported global MCP override does not invalidate a healthy private runtime.
8. On any installation or private-runtime verification failure, never copy the backup over the failed runtime. Rename the failed runtime to a unique sibling failure directory, rename the intact backup back to the exact original `crg-runtime` path, then verify the restored CLI version and all four parser probes. Report rollback failure separately and preserve every recoverable directory for manual recovery.
9. On success, retain the backup until the user restarts Codex, creates a new task, and confirms the plugin-native MCP exposes graph tools. Report old version, new version, backup path, doctor result, and restart requirement.

Do not claim success from a package installer exit code alone.
