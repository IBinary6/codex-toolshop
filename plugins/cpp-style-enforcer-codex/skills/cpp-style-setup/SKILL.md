---
name: cpp-style-setup
description: Configure or explain cpp-style-enforcer-codex project settings for C++ style enforcement in Codex.
---

# C++ Style Enforcer Setup

Use this skill when the user asks to configure, inspect, or explain `cpp-style-enforcer-codex`.

## Configuration

The plugin uses two compatible configuration layers:

1. Global defaults at `~/.codex/cpp-style-template.json`.
2. Project overrides at `<project-root>/.codex-cpp-style/cpp-style.json`.

The legacy `<project-root>/.claude-cpp-style/cpp-style.json` path is still read for compatibility, but new configs should use `.codex-cpp-style`.

Project settings override global defaults field by field.

```json
{
  "enabled": true,
  "mode": "incremental",
  "checks": { "clangFormat": true, "copyright": true, "cpplint": true, "bom": true },
  "legacyChecks": { "clangFormat": false, "copyright": false, "cpplint": false, "bom": false },
  "copyrightInfo": { "company": "", "author": "", "dateFormat": "YYYY/MM/DD HH:mm" }
}
```

## Behavior

- `mode: "incremental"`: new files run the full workflow; existing git-tracked files use `legacyChecks`.
- `mode: "full"`: all C/C++ files run the full workflow, while tracked files still preserve their original BOM state.
- `checks.clangFormat`: formats with Google style.
- `checks.cpplint`: blocks hard Google C++ style violations.
- `checks.copyright`: writes a copyright header only when `copyrightInfo.company` is non-empty.
- `checks.bom`: adds UTF-8 BOM to new C/C++ files; existing tracked files keep their original BOM state.
- Formatting and copyright updates preserve each file's original CRLF or LF line endings.
- Commit-time cpplint checks staged source files and staged `CPPLINT.cfg`, not possibly different working-tree versions.

## Dependencies

Runtime hooks only detect optional dependencies; they do not run `npm install` or `pip install`.

- If `clang-format` is missing, formatting is skipped and the rest of the workflow continues.
- If `iconv-lite` is missing, GBK conversion/BOM handling for those files is skipped to avoid corrupting content.
- To enable formatting, install `clang-format==18.1.8` in the Python used by Codex, or put a compatible `clang-format` on `PATH`.

Do not edit user files unless the user asks for configuration changes.
