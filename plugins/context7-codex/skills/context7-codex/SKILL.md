---
name: context7-codex
description: Look up Context7 library documentation and code examples on demand.
---

Use resolve-library-id to locate a library, then query-docs to search it. If the user supplies an exact library ID, query it directly.

Find this package's root two directories above the directory containing this SKILL.md (the filename is not a directory). Run `node <absolute-package-root>/scripts/command.cjs` by absolute path. Write one JSON object `{"name":"command_alias","arguments":{...}}` to stdin and close it, or use `--input-file <absolute-JSON-file-path>`. Do not rely on the session cwd. `--list` locally lists `resolve-library-id`, `query-docs` and their original parameter schemas; `--help` explains the protocol. stdout contains one JSON object with content and structuredContent; isError or a nonzero exit means failure. Read keys only from private JSON; never put them in a request, command line, or log.

This package has no MCP entry point. If a command is missing, check this package's path and runtime using the README. Do not fall back to an old CC Switch MCP, log in automatically, or run official setup. query-docs also accepts a language string, forwarded as the official --language option. The official ctx7 0.6.0 package is prepared in this plugin runtime on the first live call. An empty apiKey uses anonymous access; inherited matching environment keys are cleared and host OAuth is isolated.

The apiKey in this plugin's private JSON may be empty for anonymous access or set to a key.

For configuration or runtime problems, read [README.md](../../README.md) and run this package's setup/doctor. Report only redacted status. Check tool results against sources and stop calling tools once the task has sufficient evidence.
