# C++ Style Enforcer for Codex

`cpp-style-enforcer-codex` installs the team's C++ style workflow into Codex through plugin hooks.

It enforces Google C++ style with:

- `clang-format` formatting
- UTF-8 BOM normalization
- optional copyright headers
- bundled `cpplint.py`
- commit-time checks for staged C++ files

## Install

From the marketplace repository:

```bash
codex plugin marketplace add <github-repo-url>
codex plugin add cpp-style-enforcer-codex@codex-toolshop
```

For local development:

```bash
codex plugin marketplace add D:/AI/codex
codex plugin add cpp-style-enforcer-codex@codex-toolshop
```

Start a new Codex thread after installation so hooks are loaded.

## Configuration

Global defaults are created at:

```text
~/.codex/cpp-style-template.json
```

Project overrides are read from:

```text
<project-root>/.claude-cpp-style/cpp-style.json
```

The project path intentionally stays compatible with the existing team convention.

## Runtime Data

Writable runtime data goes to `CLAUDE_PLUGIN_DATA` when Codex provides it. If the host does not provide it, the wrapper falls back to:

```text
~/.codex/plugins/data/cpp-style-enforcer-codex
```

The plugin package itself is treated as read-only and replaceable.

## Requirements

- Node.js 18+
- Python 3 for bundled `cpplint.py`
- `clang-format` is optional; the plugin can install the Python package form in the background when possible.

Missing optional dependencies degrade safely. The hook keeps stdout empty unless it needs to return a Codex hook decision.
