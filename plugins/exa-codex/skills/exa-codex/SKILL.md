---
name: exa-codex
description: Search for sources and read web pages with Exa on demand.
---

Use web_search_exa to find sources and web_fetch_exa to read a specific page. Legacy calls with only query remain supported; the default objective is the first 4096 characters of query.

Find this package's root two directories above the directory containing this SKILL.md (the filename is not a directory). Run `node <absolute-package-root>/scripts/command.cjs` by absolute path. Write one JSON object `{"name":"command_alias","arguments":{...}}` to stdin and close it, or use `--input-file <absolute-JSON-file-path>`. Do not rely on the session cwd. `--list` locally lists `web_search_exa`, `web_fetch_exa` and their original parameter schemas; `--help` explains the protocol. stdout contains one JSON object with content and structuredContent; isError or a nonzero exit means failure. Read keys only from private JSON; never put them in a request, command line, or log.

This package has no MCP entry point. If a command is missing, check this package's path and runtime using the README. Do not fall back to an old CC Switch MCP, log in automatically, or run official setup.

Search explicitly requests contents.highlights:true. A standalone category:people or category:company marker in query becomes the REST category and is removed from search text; other text stays intact. The default objective still uses the first 4096 characters of the original query, and an explicit objective is preserved. Use web_fetch_exa for full text when excerpts are insufficient.

Set apiKey in this plugin's private JSON before making a live call.

For configuration or runtime problems, read [README.md](../../README.md) and run this package's setup/doctor. Report only redacted status. Check tool results against sources and stop calling tools once the task has sufficient evidence.
