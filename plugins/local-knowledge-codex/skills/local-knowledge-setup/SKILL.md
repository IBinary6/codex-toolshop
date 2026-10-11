---
name: local-knowledge-setup
description: Check the Python runtime, SQLite database, full-text index, and CLI required by Local Knowledge. Use when the environment is missing, SessionStart shows a setup hint, or local knowledge cannot be recalled.
---

# Local Knowledge setup

Local Knowledge requires only the Python 3.11+ standard library; no Python packages are needed. Start with read-only diagnostics:

```text
node "<plugin-root>/scripts/python-launcher.cjs" -c "import sys; print(sys.version)"
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json stats --read-only
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json recall --read-only --query "local knowledge smoke test" --explicit --limit 1
```

The launcher validates an explicit `LOCAL_KNOWLEDGE_PYTHON` or `BUGDB_PYTHON`. Otherwise it tries `python3` and `python` on macOS, and also `py -3` on Windows. An environment variable must contain only a Python executable path, without command-line arguments.

`stats` should report the current SQLite path, the count of new general knowledge records, and the count of legacy fixes. A `schema.knowledge_items_fts_mode` of `trigram` or `unicode61` uses FTS5; `like` means the current Python SQLite lacks FTS5 and has safely fallen back. Empty query results and a `like` fallback alone are not environment failures. A nonzero process exit, missing base schema, or invalid JSON is a failure.

A database may not yet exist on first use. If the current task authorizes initializing or maintaining this plugin, run `stats` without `--read-only` to create new tables and repair indexes, then repeat the read-only check. In a read-only review, report what is missing. A legacy `bugs` table requires an explicit maintenance workflow; automatic hooks do not migrate it.

If Python is unavailable, first use an existing suitable interpreter. If installation is necessary, follow current tool policy and authorization without changing the system's default Python target. Preserve compatibility with the legacy database path; do not create another database copy unless the user specifies a migration source.

`LOCAL_KNOWLEDGE_SAVE_HINTS` controls prompts: `verified` (the compatibility default) suggests explicit saves or verified fix candidates; `explicit` suggests only explicit memory wording; `off` disables save hints. Invalid values act as `off`. All modes retain automatic recall. Hooks never save directly and cannot override host memory limits. Set this only in the host environment; do not ask for it on every task.
