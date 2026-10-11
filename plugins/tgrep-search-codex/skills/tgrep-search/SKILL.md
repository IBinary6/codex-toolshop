---
name: tgrep-search
description: Search worktree text, strings, and candidate files with a background tgrep index, or diagnose its installation, index, and service. Use CodeMap for symbol relationships and impact; read known files directly.
---

Use the absolute CLI path injected by SessionStart or SubagentStart. This is a CLI, not MCP. If absent, resolve `../../scripts/tgrep.cjs` relative to this skill rather than guessing the installation directory. Requires Node 18+; no npm install.

```bash
node "/absolute/plugin/scripts/tgrep.cjs" search -F -n -- "needle" .
node "/absolute/plugin/scripts/tgrep.cjs" search --fresh -n -- "pattern" src
node "/absolute/plugin/scripts/tgrep.cjs" search --files -g "*.cpp" -- .
node "/absolute/plugin/scripts/tgrep.cjs" doctor
```

Invoke in the target workdir. Flags precede `--` and remain separate (`-F -n`, not `-Fn`); patterns/paths follow it. With `-e`/`-f` supplying patterns or `--files`, all positionals are paths. Relative and omitted paths resolve from caller cwd. `--root DIR` selects the service/scan root without changing path meaning. Non-Git `search` may omit `--root`: it scans resolved paths without creating services/indexes or inferring roots from paths. Non-Git `ensure/status/doctor/stop` still require explicit `--root DIR`.

Ordinary queries use healthy services. Pending, unhealthy, and zero-match results trigger live scans. Use `--fresh` for critical checks after edits: watcher delay means zero-match fallback cannot complete partial nonempty results. The default limit is 64 MiB; use `--no-max-filesize` for large files, `-E gbk` for live scans with GBK, and rg for byte-exact search.

During installation the wrapper may fall back to rg, identifying the engine on stderr; fallback is not byte-for-byte equivalent. Unknown flags fail explicitly rather than passing through. See `--help` and the [plugin documentation](../../README.md) for supported flags and lifecycle. Do not equate service startup with completed indexing: exit 1 means no matches for this query, while 2 means an error.

Upstream stable releases are checked every 7 days in the background. Doctor activeVersion/serviceVersion may differ temporarily; queries use the live service's version. Update failures must not block retrieval. Run `node "/absolute/plugin/scripts/tgrep.cjs" check-updates` to retry immediately. This does not update Codex plugin source.
