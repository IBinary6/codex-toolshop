---
name: local-knowledge-migrate
description: Verify or migrate legacy local SQLite knowledge records into the current Local Knowledge database. Use only when the user requests migration, import of old records, or diagnosis of shared data paths.
---

# Local Knowledge migrate

The current version continues to use the existing shared SQLite file, so a plugin upgrade usually needs no data copy. First run:

```text
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json stats --read-only
```

Use the compatibility migration entry point only when records still reside in a legacy directory or a separate database:

```text
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" migrate --source "<absolute path to old database>" --format text
```

Without `--source`, the compatibility migrator checks only known legacy directories. It must open the source read-only, never delete, move, or overwrite it, and deduplicate by the exact legacy record key when the target exists. After migration, rerun `stats` and verify with representative bug and general-knowledge queries.

This process migrates legacy-format records only. If the new tables already exist in the same database, do not import them again.
