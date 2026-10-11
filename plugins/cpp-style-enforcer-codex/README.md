# C++ Style Enforcer for Codex

`cpp-style-enforcer-codex` integrates team C++ coding rules into the Codex workflow. After installation, Codex hooks run style checks and repairs automatically; users do not need to configure legacy hooks manually.

## Relationship to the Claude Code version

The plugin supports existing team configuration: new files and projects get the full workflow, while existing files use `legacyChecks` to select formatting and lint checks. Before a commit, cpplint checks a snapshot of the staged content without rewriting the worktree. The Codex version adds a separate line-ending repair: **Visual Studio source projects use CRLF; other projects follow configuration. A missing final newline is repaired, not hidden with a filter.**

| Behavior | Codex version | Claude Code version |
| --- | --- | --- |
| After an edit | `PostToolUse` records touched files; `Stop` processes them together | `PostToolUse` processes edited files in sequence |
| Before a commit | Recognizes an actual `git commit` and checks only staged C++ files | Also recognizes `git commit` and checks the staging area |
| New and existing files | `.codex-cpp-style/cpp-style.json`, with `.claude-cpp-style` compatibility | `.claude-cpp-style/cpp-style.json` plus a global template |
| cpplint line endings | Normalize endings by project rules and add a final newline before lint; keep newline checks enabled | Existing LF/CRLF behavior |
| Dependencies | Detect at runtime; never automatically run `pip/npm install` | Detect at runtime; never automatically run `pip/npm install` |

Legacy configuration remains supported. The Codex line-ending behavior does not imply any change or release of the Claude Code version.

## Installation

1. Add the plugin marketplace:

```bash
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
```

2. Install the plugin:

```bash
codex plugin add cpp-style-enforcer-codex@codex-toolshop
```

3. Open a new Codex conversation to load the hooks and skill.

## What it does

The plugin registers four hook types:

| Hook | Trigger | Action |
| --- | --- | --- |
| `SessionStart` | A conversation starts, resumes, or clears context | Prepare a missing user template; do not write project files or install anything over the network. |
| `PostToolUse` | Codex writes or edits a file | Record only C/C++ files edited in this turn in the plugin data directory; do not read or rewrite source files. |
| `Stop` | Codex is about to finish a turn | Format touched files and apply BOM, copyright, and project line-ending rules, then run cpplint. If files changed or violations remain, ask Codex to complete final verification. |
| `PreToolUse` | Before Codex executes a Bash command | Recognize a real `git commit`, check only staged C/C++ files, and block the commit on violations without rewriting files. |

The workflow covers `clang-format`, UTF-8 BOM normalization for new files (tracked files retain their original BOM state), copyright header insertion or updates, bundled `cpplint.py`, and staged-content checks before commits.

## Configuration

The default global template is written to `~/.codex/cpp-style-template.json`. Project overrides belong in `<project-root>/.codex-cpp-style/cpp-style.json`. The plugin prefers `.codex-cpp-style` and also reads the existing team `.claude-cpp-style` configuration, so old projects need no migration.

## Runtime data

Writable plugin runtime data uses Codex's `PLUGIN_DATA` environment variable when provided. Otherwise, it falls back to the user-level Codex plugin data directory. The installed plugin directory is treated as a read-only, replaceable package.

## Dependencies

- Node.js 18+.
- Python 3 for the bundled `cpplint.py`.
- Optional `clang-format`; formatting is skipped if absent while other checks continue.
- Optional `iconv-lite`; without it, GBK transcoding and BOM handling are skipped to avoid file corruption.

Hooks only detect dependencies at runtime; they do not run `npm install` or `pip install`. The Python launcher verifies that the interpreter is Python 3 and supports the standard Windows `py -3` invocation. To install the tested formatter version in a normal terminal:

```bash
python3 -m pip install clang-format==18.1.8
```

On Windows:

```text
py -3 -m pip install clang-format==18.1.8
```

`iconv-lite` must come from the plugin package or a Codex-provided plugin data directory. Running `npm install` in an arbitrary working directory does not make it resolvable by hooks. Without it, GBK transcoding and BOM handling safely skip those files. Hooks are quiet by default, emitting a Codex decision only to block an operation or report a significant issue.

## Deferred checks

Editing does not immediately run `clang-format` or rewrite a BOM, avoiding intermediate diffs during consecutive Codex edits. At the end of a turn, `Stop` processes the C/C++ files touched in that turn. If normalization changes them or cpplint still reports violations, the hook asks Codex to review the final diff, fix issues, and verify again. A turn already continued automatically by Stop shows remaining issues without forcing another continuation. Pre-commit hooks always check without modifying.

`PostToolUse` silently records paths and injects no model context. `Stop` is also silent when there are no rewrites or violations. A rewrite report lists at most ten paths and shows a count for the rest, keeping large edits from filling the context.

Project configuration is generated only after an actual edit. Both new and old files prefer an existing `.clang-format` or `_clang-format`, including an inherited parent configuration; Google is only the fallback. cpplint reads BOM files without modifying them. Missing runtime, abnormal exit, or an incomplete check cannot count as a pass.

New Visual Studio source files and all tracked files keep their include order, avoiding a move of `windows.h` after headers that depend on its types or macros. New files in other projects follow project sort settings. Existing `clang-format off/on` protection must be retained. VS Stop and commit checks disable only cpplint's `build/include_order`; all other checks continue.

Automatic edit processing, Stop, and commit checks exclude these third-party directory segments, as does the bundled cpplint wrapper: `3rd`, `3rdparty`, `3rd_party`, `3rd-party`, `thirdparty`, `third_party`, `third-party`, `thirdpart`, `third_part`, `third-part`, `thridpart`, `thridparty`, `thrid_party`, `thrid-party`, `vendor`, `external`, `deps`, `packages`. Matching uses complete path segments without case sensitivity, so a business path such as `third_party_adapter` is not excluded. Those directories receive no automatic BOM, newline, copyright, formatting, or lint changes. Identify an unlisted custom directory as third party before deciding its scope. When using the raw Python cpplint CLI manually, select files first; the raw CLI has no such directory filter.

## Line-ending policy

After formatting, BOM, and copyright handling, and before cpplint, `Stop` runs a separate line-ending repair. Edited files in Visual Studio source projects use CRLF even if previously converted to LF. Other projects select `"lf"`, `"crlf"`, or `"preserve"` (default) through the global template or project `lineEnding` setting. Preserve mode chooses the majority ending in the existing body, the first ending on a tie, or LF if none exists; mixed endings are normalized to that choice.

Project detection checks only ancestor directories of the source file for the nearest marker. `.vcxproj`, `.vcproj`, `.sln`, and `.slnx` indicate a Visual Studio source project; the nearest `CMakeLists.txt` indicates CMake. Visual Studio files generated under a CMake build directory are not native VS markers, and sibling build directories are not scanned. If both build entries are in one directory, CMake takes precedence. Set project `lineEnding: "crlf"` explicitly if CRLF is needed in such a layout or when the marker is outside the source ancestry. For example, a CMake project can request LF:

```json
{ "lineEnding": "lf" }
```

A nonempty body missing its final newline gets exactly one ending of the selected style. Existing trailing blank lines are retained. This basic rule also applies to edited tracked files with `legacyChecks` disabled and does not require clang-format; `enabled: false` disables all processing. Only files edited in the current turn are repaired, without a repository-wide conversion.

The line-ending step preserves the bytes and BOM of UTF-8, GBK, and BOM-bearing UTF-16 files. Unknown content containing NUL bytes is not transcoded. Existing BOM policy remains: tracked files are not forced to gain or lose a BOM.

Before a commit, cpplint reads Git staging-area blobs and runs in a temporary directory using repository-relative paths. A project's `CPPLINT.cfg` is also read from the staging area. Thus results match the actual staged content even if a VS worktree uses CRLF while `core.autocrlf` stores LF, or if the worktree has further unstaged edits. The worktree is never temporarily rewritten.

Neither `whitespace/ending_newline` nor all of `whitespace/newline` is disabled. The bundled cpplint accepts uniform LF and CRLF. Mixed endings are reported according to project rules rather than recommending unconditional LF conversion. Other code-layout checks under `whitespace/newline` remain active. If the version lacking a final newline is already staged, worktree repair does not change the index: update only the intended staged scope, preserving unstaged changes, then check again.
