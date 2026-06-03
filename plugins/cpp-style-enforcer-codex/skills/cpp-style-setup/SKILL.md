---
name: cpp-style-setup
description: Configure or explain cpp-style-enforcer-codex project settings for C++ style enforcement in Codex.
---

# C++ Style Enforcer Setup

Use this skill when the user asks to configure, inspect, or explain `cpp-style-enforcer-codex`.

## Configuration

The plugin uses two compatible configuration layers:

1. Global defaults at `~/.codex/cpp-style-template.json`.
2. Project overrides at `<project-root>/.claude-cpp-style/cpp-style.json`.

Project settings override global defaults field by field.

```json
{
  "enabled": true,
  "mode": "incremental",
  "checks": { "clangFormat": true, "copyright": true, "cpplint": true, "bom": true },
  "legacyChecks": { "clangFormat": false, "copyright": false, "cpplint": false, "bom": true },
  "copyrightInfo": { "company": "", "author": "", "dateFormat": "YYYY/MM/DD HH:mm" }
}
```

## Behavior

- `mode: "incremental"`: new files run the full workflow; existing git-tracked files use `legacyChecks`.
- `mode: "full"`: all C/C++ files run the full workflow.
- `checks.clangFormat`: formats with Google style.
- `checks.cpplint`: blocks hard Google C++ style violations.
- `checks.copyright`: writes a copyright header only when `copyrightInfo.company` is non-empty.
- `checks.bom`: normalizes UTF-8 BOM, except in CMake projects.

Do not edit user files unless the user asks for configuration changes.
