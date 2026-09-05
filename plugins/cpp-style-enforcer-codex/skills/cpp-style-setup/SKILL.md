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
- `checks.clangFormat`: uses the applicable `.clang-format` or `_clang-format`; Google is only the fallback. Tracked files keep include order while formatting changed lines.
- `checks.cpplint`: blocks hard Google C++ style violations.
- `checks.copyright`: writes a copyright header only when `copyrightInfo.company` is non-empty.
- `checks.bom`: adds UTF-8 BOM to new C/C++ files; existing tracked files keep their original BOM state.
- Formatting and copyright updates preserve each file's original CRLF or LF line endings.
- Commit-time cpplint checks staged source files and staged `CPPLINT.cfg`, not possibly different working-tree versions.
- SessionStart prepares only the plugin's user template; project files are initialized after an actual C++ edit, not merely by opening a repository for inspection.
- cpplint reads BOM files without rewriting them. Missing runtime, nonzero exit without parsed diagnostics, or an incomplete staged check cannot count as a pass.
- Stop checks use the Git root for header guards. Without Git, they use a containing task working directory, then the source file's directory; guards must not depend on a user's absolute machine path.

The plugin bundles `hooks/js/cpplint/cpplint.py`; a missing `cpplint` command on `PATH` does not mean its Hook check is unavailable. For a targeted manual check, use the bundled script and the same root as the Hook:

```bash
python3 <plugin-root>/hooks/js/cpplint/cpplint.py --root=<project-root> <source-file>
```

On Windows, use the available Python 3 launcher, such as `py -3`. Preserve the project's `CPPLINT.cfg` and effective filters; a direct invocation without those settings may report checks intentionally configured differently in the Hook.

## Dependencies

Runtime hooks only detect optional dependencies; they do not run `npm install` or `pip install`.

- If `clang-format` is missing, formatting is skipped and the rest of the workflow continues.
- If `iconv-lite` is missing, GBK conversion/BOM handling for those files is skipped to avoid corrupting content.
- To enable formatting, install `clang-format==18.1.8` in the Python used by Codex, or put a compatible `clang-format` on `PATH`.

Do not edit user files unless the user asks for configuration changes.
