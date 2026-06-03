# Codex Toolshop

Codex Toolshop is a Codex plugin marketplace maintained by IBinary6.

## Plugins

- `cpp-style-enforcer-codex` - C++ code style enforcement for Codex, based on Google C++ Style with clang-format, cpplint, copyright headers, BOM handling, and commit-time checks.

## Installation

Register this marketplace, then install the plugin:

```bash
codex plugin marketplace add <github-repo-url>
codex plugin add cpp-style-enforcer-codex@codex-toolshop
```

For local development from this checkout:

```bash
codex plugin marketplace add D:/AI/codex
codex plugin add cpp-style-enforcer-codex@codex-toolshop
```

Open a new Codex thread after installing so plugin hooks and skills are loaded.
