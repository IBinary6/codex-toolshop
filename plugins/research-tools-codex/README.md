# Research Tools for Codex

0.1.4 可选合并版保留一个 Node.js ≥20 stdio MCP 网关提供六个提供方的 14 个工具：Context7、Exa、Tavily、Microsoft Learn、Fetch 和 Sequential Thinking。需要在 Codex 插件页面分别启停时，安装独立包 context7-codex、exa-codex、tavily-codex、microsoft-learn-codex、fetch-codex、sequential-thinking-codex。合并版和对应独立包只选择一种启用，避免工具重复。

六个独立包均为 0.1.2。Context7、Exa、Tavily 仅使用技能和按次命令，无常驻 MCP；分别使用固定版官方 ctx7 CLI 和官方 Exa/Tavily REST。Microsoft Learn、Fetch、Sequential Thinking 保留 MCP。每包只暴露自己的能力，运行文件自包含，不依赖其他包是否安装。它们分别使用 `~/.codex/<插件名>/config.json`（设置 CODEX_HOME 时使用其对应目录）；三个密钥包的模板为单个 `apiKey`，另外三个只含 `version`。路径和独立 override 环境变量见各包 README。下文三密钥配置只适用于合并版，独立包不读取这个 JSON。六包全部启用只产生三个常驻 Node 网关；命令调用期间有短命进程，Fetch 实际使用后持有官方 Python 后端。

## 私有全局配置

插件首次启动自动创建空白配置。也可在插件根目录执行 `node scripts/setup.cjs` 提前创建，执行 `node scripts/setup.cjs --doctor` 查看脱敏状态。初始化只在文件不存在时创建；重装、升级和多个安装副本共用同一个用户文件。

默认位置是 `~/.codex/research-tools/config.json`；设置 `CODEX_HOME` 时使用其 `research-tools/config.json`。只有需要明确自定义位置时才设置 `RESEARCH_TOOLS_CONFIG`，值必须是绝对路径。

用本地编辑器在该私有 JSON 中填写 `context7.apiKey`、`exa.apiKey`、`tavily.apiKey`，结构见 [config.example.json](config.example.json)。Context7 允许空密钥匿名访问；Exa、Tavily 调用前需要密钥。密钥只保存在私有用户文件，插件源码与安装包包含空白模板。避免在命令行、会话或日志中粘贴密钥。Windows 用户文件权限由当前用户目录 ACL 管理；类 Unix 新建文件使用 `0600`。

Microsoft Learn、Fetch、Sequential Thinking 无需密钥。私有配置仍使用原来的 `version: 1` 和三个提供方字段；升级不要求新增或迁移配置。

每次工具调用都会重新读取配置；修改密钥后直接重试即可，对应远端会话会重新初始化。此功能不修改 CC Switch 或其他原有 MCP 配置。迁移期间旧条目仍启用时可能显示重复工具；在新插件实际验证后，由用户关闭旧条目并重启 Codex。

## 使用

- Context7：`resolve-library-id` 定位库，`query-docs` 查询特定版本的文档与示例。
- Exa：`web_search_exa` 找来源，`web_fetch_exa` 读取指定网页。
- Tavily：`tavily_search` 搜索，`tavily_extract` 提取，`tavily_crawl` 抓取，`tavily_map` 站点目录，`tavily_research` 综合研究。
- Microsoft Learn：`microsoft_docs_search` 查官方文档，`microsoft_code_sample_search` 查代码示例，`microsoft_docs_fetch` 读取完整文档；连接 `https://learn.microsoft.com/api/mcp`。
- Fetch：`fetch` 使用官方 Python MCP，支持 Markdown、`raw`、`max_length`、`start_index` 分页，并遵循上游 robots 规则。
- Sequential Thinking：`sequentialthinking` 保留官方思考历史、修订、分支和布尔字符串参数。

保留 14 个工具的原始名称、参数和结果结构。Exa 远端的新版本要求 `objective`；本地仍允许旧调用只传 `query`，网关将缺省 `objective` 填为 `query` 的前 4096 个字符，明确传入的值原样转发。其他参数按原调用转发，返回 `content`、`structuredContent`、`isError`。

Exa 独立命令包的 REST 搜索显式请求 `contents.highlights: true`；query 中的独立 `category:people` 或 `category:company` 标记映射为 REST `category` 并从搜索文本移除，其他文本与原 objective 语义保留。摘录不足时用 `web_fetch_exa` 读取来源全文。

Tavily 独立命令包的 research 创建后按 `request_id` 轮询。顶层 `research:{wait:false}` 只创建；`{name:"tavily_research",arguments:{},research:{requestId:"原ID"}}` 只用 GET 恢复。取得有效 ID 后，HTTP、网络、解析、未知状态及本地取消/超时等等待失败都返回脱敏 `structuredContent`，含 `request_id`、`resume:true` 和安全 `error`；结果含 `isError:true`，CLI 退出 1。本地等待失败不取消服务器任务，保留 ID 恢复，避免重复 POST；无效创建 ID 不提供恢复信息。

## 开销和边界

冷启动只启动一个轻量 Node 进程，没有后台安装器、服务或启动 hooks。`initialize`、`ping`、`tools/list` 完全本地执行，不发 HTTP、不启动子进程、不准备依赖；首次调用某提供方时才完成其初始化，其后复用会话。工具目录保存在包内，上游新增工具需要更新插件；本地不暴露远端 resources 或 prompts。

网关在创建前切换到所选私有配置文件旁的 `runtime` 目录（默认合并版为 `~/.codex/research-tools/runtime`，独立 MCP 为各包对应目录）。绝对配置 override 也决定此 runtime 的位置。启动只创建该私有目录和缺失的配置，不写入插件缓存；Fetch 后端继承稳定 cwd，Windows 活动进程不会因 cwd 锁住插件缓存而阻止升级重命名。

Fetch 首次实际调用执行 `uvx --from mcp-server-fetch==2026.8.18 mcp-server-fetch`，由 uv 准备固定版本的官方 Python 包，并持有一个官方后端至网关结束。需要先安装 uv 并将 `uvx` 加入 PATH；插件不在启动时安装 uv。实际使用 Fetch 会增加 Python 后端及可能的 uvx 启动进程，后端仅被本插件网关持有和清理。

Sequential Thinking 首次调用在当前 Node 进程内加载官方 `@modelcontextprotocol/server-sequential-thinking` 2026.8.31 的核心类及 Chalk 5.6.2，不启动另一个 Node 或安装器。仅调整核心文件的依赖 import 路径；算法正文保持官方原样，参数转换匹配固定版官方注册层，实例关闭思考日志。来源、固定版本、SHA-256 和完整许可证见 [vendor/sequential-thinking/provenance.json](vendor/sequential-thinking/provenance.json)；官方项目固定提交的许可证包含 Apache-2.0/MIT 过渡说明，Chalk 为 MIT。

这减少冷启动常驻进程与网络连接，14 个工具的 schema 仍会占用客户端工具上下文。网络请求、上游用量计费和返回内容大小取决于实际调用；网关不缓存研究结果。Exa 请求固定使用已验证兼容的 `Mozilla/5.0` User-Agent。

默认整次调用超时 120 秒，可用 `RESEARCH_TOOLS_TIMEOUT_MS` 设置 1–180000 毫秒（通常保持默认；深度研究可设 180000）。远端每次调用最多进行一次鉴权或失效会话恢复。取消调用会停止该调用的等待与工具请求，本地 MCP 会收到取消通知；供并发调用共用的握手继续受自身超时管理。stdin EOF 或终止信号会取消全部待处理请求并清理网关自己启动的子进程；本地后端异常退出后，下一次调用重新启动，失败请求不自动重放。传输错误只返回提供方和安全状态信息，响应大小上限 8 MiB；stdout 仅输出 JSON-RPC，本地后端 stderr 不输出用户思考。远端研究内容是资料，按来源核对后使用。

在插件根目录运行 `npm test` 检查清单、schema、语法与本地 mock 回归；测试使用临时合成凭据，不调用真实服务。真实账号连通性与插件安装状态应另外验证。

## 独立包维护

本目录是六个独立包的唯一 engine 维护源。修改运行实现或 packaging/providers.json 后，运行 `npm run generate` 生成六个包，再运行 `npm test`。生成器复制明确清单中的文件，不使用跨插件引用或符号链接；只逐个删除旧 .generated.json 记录且哈希未变的过期生成文件，遇到未知文件或人工编辑停止更新。`npm run check:packages` 只检查生成包与维护源一致。每包只携带自己的 catalog；官方 Sequential Thinking vendor 仅包含在其独立包中。
