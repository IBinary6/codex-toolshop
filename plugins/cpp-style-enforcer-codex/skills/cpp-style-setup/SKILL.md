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
  "lineEnding": "preserve",
  "checks": { "clangFormat": true, "copyright": true, "cpplint": true, "bom": true },
  "legacyChecks": { "clangFormat": false, "copyright": false, "cpplint": false, "bom": false },
  "copyrightInfo": { "company": "", "author": "", "dateFormat": "YYYY/MM/DD HH:mm" }
}
```

## Behavior

- `mode: "incremental"`: new files run the full workflow; existing git-tracked files use `legacyChecks`.
- `mode: "full"`: all C/C++ files run the full workflow, while tracked files still preserve their original BOM state.
- `checks.clangFormat`: uses the applicable `.clang-format` or `_clang-format`; Google is only the fallback. Tracked files keep include order while formatting changed lines. New VS source files also keep include order; other new files follow project sorting settings. Preserve local `clang-format off/on` protection around dependency-sensitive includes. VS hook checks disable only cpplint's `build/include_order`, so cpplint does not demand undoing this protection.
- `checks.cpplint`: blocks hard Google C++ style violations.
- `checks.copyright`: writes a copyright header only when `copyrightInfo.company` is non-empty.
- `checks.bom`: adds UTF-8 BOM to new C/C++ files; existing tracked files keep their original BOM state.
- After formatting and copyright updates, a separate step enforces CRLF for edited Visual Studio source-project files, including files previously converted to LF. Other projects use `lineEnding: "lf" | "crlf" | "preserve"` (default). Preserve mode chooses the dominant existing ending, then the first ending on a tie, or LF for a file without any ending. Nonempty files receive a missing final newline in the selected style. This basic step also runs for edited tracked files with legacy style checks disabled and does not require clang-format; `enabled: false` disables it.
- Detect project type from the nearest source ancestor: `.vcxproj`, `.vcproj`, `.sln`, `.slnx` identify VS; `CMakeLists.txt` takes precedence in the same directory, and generated CMake VS files are ignored. Do not recursively classify sibling projects or build outputs. Use explicit `lineEnding: "crlf"` for ambiguous dual-build or external-source layouts that require CRLF.
- The line-ending step preserves byte encoding and BOM, and skips unknown NUL-bearing content. It changes only edited files, not every project file. Review the final diff after automatic repair.
- Commit-time cpplint checks staged source files and staged `CPPLINT.cfg`, not possibly different working-tree versions.
- Keep both `whitespace/ending_newline` and `whitespace/newline` checks. Uniform LF and CRLF are valid for cpplint, including LF index blobs produced from CRLF worktrees by Git. Repair missing final newlines with the project's ending, never convert a VS worktree to LF to satisfy a mixed-ending diagnostic. If the staged version still has a defect after worktree repair, update only the intended staged scope; do not silently stage unrelated edits or mutate the index in a hook.
- SessionStart prepares only the plugin's user template; project files are initialized after an actual C++ edit, not merely by opening a repository for inspection.
- cpplint reads BOM files without rewriting them. Missing runtime, nonzero exit without parsed diagnostics, or an incomplete staged check cannot count as a pass.
- Stop checks use the Git root for header guards. Without Git, they use a containing task working directory, then the source file's directory; guards must not depend on a user's absolute machine path.

The plugin bundles `hooks/js/cpplint/cpplint.py`; a missing `cpplint` command on `PATH` does not mean its Hook check is unavailable. Automatic processing excludes case-insensitive directory segments `3rd`, `3rdparty`, `3rd_party`, `3rd-party`, `thirdparty`, `third_party`, `third-party`, `thirdpart`, `third_part`, `third-part`, `thridpart`, `thridparty`, `thrid_party`, `thrid-party`, `vendor`, `external`, `deps`, and `packages`, plus build-output directories. Do not review, format, normalize or manually lint their implementations unless explicitly requested. Review first-party integration contracts and read only the dependency interfaces needed for context. Substrings such as `third_party_adapter` do not exclude a business directory.

For a targeted manual check, select a first-party source file and use the bundled script and the same root as the Hook. The raw Python CLI does not apply the hook's directory exclusion; never pass a recursive vendor list. For a VS source project add `--filter=-whitespace/indent_namespace,-build/include_order` (append `-legal/copyright` only when that check is disabled):

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
