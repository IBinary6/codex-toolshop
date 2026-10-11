# Research Tools for Codex

The optional combined package, version 0.1.4, exposes 14 tools from six providers through one Node.js ≥20 stdio MCP gateway: Context7, Exa, Tavily, Microsoft Learn, Fetch, and Sequential Thinking. To enable providers independently on the Codex plugin page, install context7-codex, exa-codex, tavily-codex, microsoft-learn-codex, fetch-codex, and sequential-thinking-codex. Enable either the combined package or a corresponding independent package to avoid duplicate tools.

The six independent packages are version 0.1.2. Context7, Exa, and Tavily use skills and per-call commands without a persistent MCP. They use the pinned official ctx7 CLI and official Exa/Tavily REST APIs. Microsoft Learn, Fetch, and Sequential Thinking retain MCP. Each package exposes only its own capabilities and contains all its runtime files. Each has a separate `~/.codex/<plugin-name>/config.json` (or a corresponding directory under CODEX_HOME). The three packages needing keys have a single `apiKey` field; the others contain only `version`. See each package README for its path and override variable. The three-key configuration below applies only to the combined package. Enabling all six packages keeps only three Node gateways running; command calls create short-lived processes, and Fetch holds the official Python backend after use.

## Private global configuration

The plugin creates blank configuration on first startup. To create it beforehand, run `node scripts/setup.cjs` in the plugin root. Run `node scripts/setup.cjs --doctor` to view redacted status. Initialization creates the file only if missing; reinstallations, upgrades, and multiple installations share the same user file.

The default path is `~/.codex/research-tools/config.json`, or `research-tools/config.json` under `CODEX_HOME` when set. Set `RESEARCH_TOOLS_CONFIG` to an absolute path only when a custom location is needed.

Use a local editor to set `context7.apiKey`, `exa.apiKey`, and `tavily.apiKey` in that private JSON; see [config.example.json](config.example.json). Context7 accepts an empty key for anonymous access. Exa and Tavily require keys before live calls. Keys remain in the private user file; plugin source and packages contain blank templates. Never paste keys into commands, conversations, or logs. Windows user-file permissions are governed by the current user-directory ACL; new Unix-like files use `0600`.

Microsoft Learn, Fetch, and Sequential Thinking need no key. The private configuration retains its original `version: 1` and three provider fields; upgrading does not require a configuration migration.

Every tool call rereads configuration. After changing a key, retry the call; the corresponding remote session is reinitialized. This feature does not change CC Switch or existing MCP configuration. During migration, old entries may still display duplicate tools. After verifying the new plugin, the user can disable the old entry and restart Codex.

## Usage

- Context7: `resolve-library-id` locates a library; `query-docs` queries documentation and examples for a specific version.
- Exa: `web_search_exa` finds sources; `web_fetch_exa` reads a specified page.
- Tavily: `tavily_search` searches, `tavily_extract` extracts, `tavily_crawl` crawls, `tavily_map` maps a site, and `tavily_research` synthesizes sources.
- Microsoft Learn: `microsoft_docs_search` finds official documentation, `microsoft_code_sample_search` finds code examples, and `microsoft_docs_fetch` reads a full document through `https://learn.microsoft.com/api/mcp`.
- Fetch: `fetch` uses the official Python MCP with Markdown, `raw`, `max_length`, and `start_index` pagination, following upstream robots rules.
- Sequential Thinking: `sequentialthinking` preserves the official thought history, revisions, branches, and boolean-string arguments.

The 14 tool names, parameters, and result structures remain intact. A newer Exa remote requires `objective`; local callers may still supply only `query`. The gateway defaults `objective` to the first 4096 characters of `query` and forwards an explicit value unchanged. Other parameters are forwarded as before, and results retain `content`, `structuredContent`, and `isError`.

The independent Exa command package explicitly requests `contents.highlights: true` for REST search. A standalone `category:people` or `category:company` marker in query becomes the REST `category` and is removed from search text; other text and the original objective semantics remain. Use `web_fetch_exa` when an excerpt is insufficient.

The independent Tavily command package polls a research job by `request_id` after creating it. Top-level `research:{wait:false}` only creates a job; `{name:"tavily_research",arguments:{},research:{requestId:"original-id"}}` resumes using GET only. Once a valid ID exists, waiting failures from HTTP, network, parsing, unknown status, local cancellation, or timeout return redacted `structuredContent` with `request_id`, `resume:true`, and a safe `error`. The result has `isError:true`, and the CLI exits 1. A local waiting failure does not cancel the server job. Retain the ID to resume without a duplicate POST. An invalid creation ID has no resume information.

## Cost and boundaries

Cold startup launches only one lightweight Node process, with no background installer, service, or startup hook. `initialize`, `ping`, and `tools/list` execute locally without HTTP, child processes, or dependency preparation. A provider initializes only on its first call, then reuses its session. The tool catalog is packaged locally, so newly added upstream tools require a plugin update. Remote resources and prompts are not exposed.

Before creating the gateway, it switches to the `runtime` directory beside the selected private configuration file (by default `~/.codex/research-tools/runtime` for the combined package, or the corresponding independent MCP directory). An absolute configuration override also determines this runtime location. Startup creates only that private directory and missing configuration, not plugin-cache files. The Fetch backend inherits a stable cwd, so an active Windows process does not lock the plugin cache against upgrade renames.

On the first live Fetch call, `uvx --from mcp-server-fetch==2026.8.18 mcp-server-fetch` prepares the pinned official Python package and keeps an official backend until the gateway closes. Install uv and put `uvx` on PATH beforehand; the plugin does not install uv at startup. Using Fetch adds the Python backend and possibly a uvx startup process. Only this plugin gateway owns and cleans up that backend.

On its first call, Sequential Thinking loads the official `@modelcontextprotocol/server-sequential-thinking` 2026.8.31 core class and Chalk 5.6.2 in the current Node process, without another Node process or installer. Only the core file's dependency import path is adapted; the official algorithm remains intact. Parameter conversion matches the pinned official registration layer, and thought logging is disabled per instance. Sources, pinned versions, SHA-256 hashes, and full licenses are in [vendor/sequential-thinking/provenance.json](vendor/sequential-thinking/provenance.json). The pinned official project license describes an Apache-2.0/MIT transition; Chalk is MIT.

This reduces idle processes and network connections, although the 14 tool schemas still occupy client tool context. Network requests, upstream usage charges, and response sizes depend on actual calls; the gateway does not cache research results. Exa requests use the verified compatible `Mozilla/5.0` User-Agent.

The default whole-call timeout is 120 seconds. Set `RESEARCH_TOOLS_TIMEOUT_MS` to 1–180000 milliseconds if needed (normally leave the default; deep research may use 180000). Each remote call makes at most one authentication or expired-session recovery attempt. Cancelling a call stops its wait and tool request and notifies a local MCP backend. A handshake shared by concurrent calls retains its own timeout. stdin EOF or a termination signal cancels all pending requests and cleans up child processes started by the gateway. After a local backend exits unexpectedly, the next call restarts it; failed calls are not replayed automatically. Transport errors return only the provider and safe status information. Responses are limited to 8 MiB; stdout contains JSON-RPC only, and local backend stderr does not expose user thoughts. Treat remote research content as source material to verify.

Run `npm test` in the plugin root for catalog, schema, syntax, and local mock regression checks. Tests use temporary synthetic credentials and do not contact live services. Live account connectivity and plugin installation status require separate verification.

## Independent package maintenance

This directory is the sole engine maintenance source for the six independent packages. After changing runtime code or packaging/providers.json, run `npm run generate` to generate all six packages, then `npm test`. The generator copies an explicit file list without cross-plugin references or symlinks. It removes an obsolete file only if its hash matches the previous .generated.json snapshot; unknown files or manual edits stop the update. `npm run check:packages` only checks that generated packages match their maintenance source. Each package carries only its own catalog; the official Sequential Thinking vendor is included only in its independent package.
