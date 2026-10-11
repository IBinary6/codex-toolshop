---
name: tavily-codex
description: Search, extract, crawl, and conduct research with Tavily on demand.
---

Use search/extract for finding and extracting pages; map/crawl for a defined site scope; research when the task calls for synthesis across sources. Check the original task and usage before expanding the scope.

Find this package's root two directories above the directory containing this SKILL.md (the filename is not a directory). Run `node <absolute-package-root>/scripts/command.cjs` by absolute path. Write one JSON object `{"name":"command_alias","arguments":{...}}` to stdin and close it, or use `--input-file <absolute-JSON-file-path>`. Do not rely on the session cwd. `--list` locally lists `tavily_search`, `tavily_extract`, `tavily_crawl`, `tavily_map`, `tavily_research` and their original parameter schemas; `--help` explains the protocol. stdout contains one JSON object with content and structuredContent; isError or a nonzero exit means failure. Read keys only from private JSON; never put them in a request, command line, or log.

This package has no MCP entry point. If a command is missing, check this package's path and runtime using the README. Do not fall back to an old CC Switch MCP, log in automatically, or run official setup. research creates a job and polls until completed/failed by default; top-level research:{wait:false} only creates the job and returns request_id. To resume, use {name:"tavily_research",arguments:{},research:{requestId:"original-id"}}, which sends only GET. A local timeout or cancellation does not cancel the server job; retain its ID to resume without creating a duplicate.

After a valid research ID is obtained, failures while waiting (HTTP, network, parsing, unknown status, local cancellation, or timeout) return redacted structuredContent with request_id, resume:true, and a safe error. isError is true and the CLI exits 1. Keep the ID and resume with the requestId form above, which sends only GET and avoids a duplicate POST. Invalid creation IDs provide no resume information.

Set apiKey in this plugin's private JSON before making a live call.

For configuration or runtime problems, read [README.md](../../README.md) and run this package's setup/doctor. Report only redacted status. Check tool results against sources and stop calling tools once the task has sufficient evidence.
