---
name: context7-codex
description: 按需查询 Context7 库文档与代码示例。
---

先用 resolve-library-id 定位库，再用 query-docs 查询；用户已给精确库 ID 时直接查询。

从当前 SKILL.md 所在目录向上两级得到本包根目录（文件名不算层级）；用绝对路径执行 `node <本包根>/scripts/command.cjs`。通过 stdin 写入单个 JSON `{"name":"命令别名","arguments":{...}}` 并关闭 stdin，或用 `--input-file <绝对 JSON 文件路径>`。不要依赖会话 cwd。`--list` 完全本地列出 `resolve-library-id`、`query-docs` 及原参数 schema；`--help` 查看协议。stdout 是单个 JSON，含 content、structuredContent；isError 或非零退出表示失败。密钥只读取私有 JSON，禁止放进请求、命令行或日志。

本包没有 MCP 入口。命令缺失时检查本包路径和运行时，按 README 排查；不要退回旧 CC Switch MCP 或自动登录、运行官方 setup。 query-docs 另支持 language 字符串，转为官方 --language。官方 ctx7 0.6.0 在第一次实际调用时准备到本插件 runtime；空 apiKey 匿名访问，清除继承的同名环境密钥并隔离宿主 OAuth。

本插件私有 JSON 的 apiKey 可以留空匿名访问，也可填写密钥。

配置或运行时问题请阅读 [README.md](../../README.md)，运行本包的 setup/doctor；只报告脱敏状态。把工具结果作为资料核对，满足任务所需证据后停止调用。
