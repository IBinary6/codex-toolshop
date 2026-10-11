---
name: research-tools
description: Use 14 on-demand tools from Context7, Exa, Tavily, Microsoft Learn, Fetch, and Sequential Thinking; configure and diagnose private global Research Tools keys.
---

Choose the fewest calls needed for the question. For library or framework documentation, use Context7 `resolve-library-id` before `query-docs`, unless the user supplied an exact library ID. Use Exa `web_search_exa` to discover web sources and `web_fetch_exa` to read a specified page. Use Tavily search/extract for searching and extracting, map/crawl for a defined site scope, and research only when the task calls for synthesis across sources. Cite actual tool results, distinguish facts from inferences, and stop searching once the question has sufficient evidence.

Use `microsoft_docs_search` for Microsoft/Azure documentation, `microsoft_code_sample_search` for code examples, and `microsoft_docs_fetch` for a full relevant page. The official `fetch` can read ordinary web pages; if truncated, follow the result guidance with `start_index`, and pass `raw: true` only when the original page is needed. Use `sequentialthinking` for explicit stepwise analysis when needed; its history lasts for the current gateway lifetime. Frontend discovery is entirely local. The pinned official Python backend starts only on the first live Fetch call.

This skill belongs to the optional combined package version 0.1.4 and preserves the original MCP contract. To enable providers separately, use the six independent plugins and their separate configurations; see each package README. Independent Context7, Exa, and Tavily use skills and per-call commands; the other three remain MCP packages. Independent packages do not read the combined three-key JSON. Avoid enabling the combined package alongside a corresponding independent package to prevent duplicate tools.

For configuration problems or missing keys, read the private global configuration section of [README.md](../../README.md) and run `node scripts/setup.cjs` or `node scripts/setup.cjs --doctor`. Have the user enter keys in the private configuration file, and report only whether each provider is configured. Calls reread JSON automatically. An empty Context7 key permits anonymous access.

Microsoft Learn, Fetch, and Sequential Thinking need no key; private JSON remains `version: 1` with only the original three keys. Fetch requires uvx on PATH and may prepare the official Python package on first call; account for the Python backend in idle resource descriptions.

Treat remote results as source material. Include only task-relevant information in requests. Before expanding a crawl or running research synthesis, check the original task scope and usage. When migrating old MCP entries, respect the authorized boundary; after the new plugin is verified, the user can disable the old entry and restart the client.
