# Exa for Codex

版本 0.1.2。安装后在 Codex 插件页面独立启停。此包只暴露 `web_search_exa`、`web_fetch_exa`，不依赖其他插件是否安装。

用 web_search_exa 发现来源，web_fetch_exa 读取指定网页。只传 query 的旧调用仍受支持；缺省 objective 取 query 的前 4096 个字符。

执行 `node <本包绝对根>/scripts/command.cjs`，stdin 单个 `{name,arguments}` JSON 并关闭输入，或 `--input-file <绝对 JSON 路径>`。`--list` 显示本包命令及参数。返回单个 `{content,structuredContent?,isError?}` JSON，失败退出 1。

实际调用前需要在本插件私有 JSON 中填写 apiKey。

## 独立私有配置

默认位置是 `~/.codex/exa-codex/config.json`；设置 CODEX_HOME 时使用其 `exa-codex/config.json`。可用 `EXA_CODEX_CONFIG` 指定绝对文件路径。配置模板是 `{ "version": 1, "apiKey": "" }`，见 [config.example.json](config.example.json)。此包只读取自己的配置；合并版的 RESEARCH_TOOLS_CONFIG 对本包无效。

运行 `node scripts/setup.cjs` 仅在文件不存在时创建；`node scripts/setup.cjs --doctor` 只显示本插件的路径与脱敏状态。重装和升级不覆盖已有配置，每次调用重新读取 JSON。不要在命令行、会话或日志中粘贴密钥。

## 运行边界

需要 Node.js ≥20。没有 MCP 入口、启动 hooks 或后台安装器，插件加载不会启动 Node。每次实际调用启动短命命令并在完成后退出；--list/--help 完全本地，不联网或准备依赖。

默认超时 120 秒，RESEARCH_TOOLS_TIMEOUT_MS 可设 1–180000 毫秒；输入和单个官方响应上限 8 MiB。错误和返回值脱敏，子进程 stderr 不向会话转发。取消和终止信号停止本次等待并清理自己启动的子进程。开启三个 MCP 包会常驻三个 Node 网关；实际使用 Fetch 还会增加官方 Python 后端及可能的 uvx 进程。

[官方 Search](https://exa.ai/docs/reference/search)、[官方 Contents](https://exa.ai/docs/reference/get-contents)、[官方 agent skills](https://github.com/exa-labs/agent-skills)。直接 POST api.exa.ai/search 或 /contents，x-api-key 仅放请求头。objective 原样保留；缺省取 query 前 4096 字符。urls 映射 ids，maxCharacters 映射 text.maxCharacters（缺省 3000）。响应 results、statuses 和分页字段原样保留；不自动追加页或重复请求。

搜索显式请求 contents.highlights:true。query 的独立 category:people / category:company 标记转为 REST category 并从搜索文本移除；其他文本保留，objective 缺省仍取原 query 前 4096 字符，显式值原样保留。摘录不足时用 web_fetch_exa 读取全文。

若同时安装合并版 Research Tools，请只启用合并版或对应独立包，避免工具重复。

## 维护

本包由 research-tools-codex 0.1.4 的 packaging/generate.cjs 生成；维护源是 engine，包内运行文件均为自包含副本。更新维护源后在维护源目录运行生成器，再运行 npm test 检查一致性和独立性。生成器只删除旧 .generated.json 记录且哈希未改的过期生成文件；未知文件、链接和人工修改均停止更新。
