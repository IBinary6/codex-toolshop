---
name: exa-codex
description: 按需使用 Exa 搜索来源和读取网页。
---

用 web_search_exa 发现来源，web_fetch_exa 读取指定网页。只传 query 的旧调用仍受支持；缺省 objective 取 query 的前 4096 个字符。

从当前 SKILL.md 所在目录向上两级得到本包根目录（文件名不算层级）；用绝对路径执行 `node <本包根>/scripts/command.cjs`。通过 stdin 写入单个 JSON `{"name":"命令别名","arguments":{...}}` 并关闭 stdin，或用 `--input-file <绝对 JSON 文件路径>`。不要依赖会话 cwd。`--list` 完全本地列出 `web_search_exa`、`web_fetch_exa` 及原参数 schema；`--help` 查看协议。stdout 是单个 JSON，含 content、structuredContent；isError 或非零退出表示失败。密钥只读取私有 JSON，禁止放进请求、命令行或日志。

本包没有 MCP 入口。命令缺失时检查本包路径和运行时，按 README 排查；不要退回旧 CC Switch MCP 或自动登录、运行官方 setup。

搜索显式请求 contents.highlights:true。query 的独立 category:people / category:company 标记转为 REST category 并从搜索文本移除；其他文本保留，objective 缺省仍取原 query 前 4096 字符，显式值原样保留。摘录不足时用 web_fetch_exa 读取全文。

实际调用前需要在本插件私有 JSON 中填写 apiKey。

配置或运行时问题请阅读 [README.md](../../README.md)，运行本包的 setup/doctor；只报告脱敏状态。把工具结果作为资料核对，满足任务所需证据后停止调用。
