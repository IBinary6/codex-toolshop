---
name: fetch-codex
description: 按需使用官方 Python Fetch MCP 读取网页。
---

fetch 保留官方 Markdown、robots、raw、max_length 与 start_index 分页行为。被截断时按结果提示继续读取；需要原始页面时传 raw: true。

无需密钥。需要 PATH 中的 uvx；首次实际调用才执行 uvx --from mcp-server-fetch==2026.8.18 mcp-server-fetch 并准备固定版官方包。Python 后端随网关关闭。

配置或运行时问题请阅读 [README.md](../../README.md)，运行本包的 setup/doctor；只报告脱敏状态。把工具结果作为资料核对，满足任务所需证据后停止调用。
