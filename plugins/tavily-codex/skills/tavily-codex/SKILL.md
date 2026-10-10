---
name: tavily-codex
description: 按需使用 Tavily 搜索、提取、抓取及综合研究。
---

search/extract 用于搜索与提取；map/crawl 用于明确站点范围；research 用于任务确实需要的多来源综合。扩大范围前核对原任务和用量。

从当前 SKILL.md 所在目录向上两级得到本包根目录（文件名不算层级）；用绝对路径执行 `node <本包根>/scripts/command.cjs`。通过 stdin 写入单个 JSON `{"name":"命令别名","arguments":{...}}` 并关闭 stdin，或用 `--input-file <绝对 JSON 文件路径>`。不要依赖会话 cwd。`--list` 完全本地列出 `tavily_search`、`tavily_extract`、`tavily_crawl`、`tavily_map`、`tavily_research` 及原参数 schema；`--help` 查看协议。stdout 是单个 JSON，含 content、structuredContent；isError 或非零退出表示失败。密钥只读取私有 JSON，禁止放进请求、命令行或日志。

本包没有 MCP 入口。命令缺失时检查本包路径和运行时，按 README 排查；不要退回旧 CC Switch MCP 或自动登录、运行官方 setup。 research 默认创建后轮询到 completed/failed；顶层 research:{wait:false} 只创建，保留 request_id。继续查询使用 {name:"tavily_research",arguments:{},research:{requestId:"原ID"}}，仅发送 GET。本地超时或取消不取消服务器任务；保留 ID 恢复，避免重复创建。

取得有效研究 ID 后，HTTP、网络、解析、未知状态及本地取消/超时等等待失败均返回脱敏 structuredContent，包含 request_id、resume:true 和安全 error；isError:true 且 CLI 退出 1。保留 ID，用上述 requestId 形式仅 GET 恢复，避免重复 POST。无效创建 ID 不返回恢复信息。

实际调用前需要在本插件私有 JSON 中填写 apiKey。

配置或运行时问题请阅读 [README.md](../../README.md)，运行本包的 setup/doctor；只报告脱敏状态。把工具结果作为资料核对，满足任务所需证据后停止调用。
