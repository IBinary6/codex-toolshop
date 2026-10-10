# Context7 for Codex

版本 0.1.2。安装后在 Codex 插件页面独立启停。此包只暴露 `resolve-library-id`、`query-docs`，不依赖其他插件是否安装。

先用 resolve-library-id 定位库，再用 query-docs 查询；用户已给精确库 ID 时直接查询。

执行 `node <本包绝对根>/scripts/command.cjs`，stdin 单个 `{name,arguments}` JSON 并关闭输入，或 `--input-file <绝对 JSON 路径>`。`--list` 显示本包命令及参数。返回单个 `{content,structuredContent?,isError?}` JSON，失败退出 1。

本插件私有 JSON 的 apiKey 可以留空匿名访问，也可填写密钥。

## 独立私有配置

默认位置是 `~/.codex/context7-codex/config.json`；设置 CODEX_HOME 时使用其 `context7-codex/config.json`。可用 `CONTEXT7_CODEX_CONFIG` 指定绝对文件路径。配置模板是 `{ "version": 1, "apiKey": "" }`，见 [config.example.json](config.example.json)。此包只读取自己的配置；合并版的 RESEARCH_TOOLS_CONFIG 对本包无效。

运行 `node scripts/setup.cjs` 仅在文件不存在时创建；`node scripts/setup.cjs --doctor` 只显示本插件的路径与脱敏状态。重装和升级不覆盖已有配置，每次调用重新读取 JSON。不要在命令行、会话或日志中粘贴密钥。

## 运行边界

需要 Node.js ≥22.13.0（按 ctx7 0.6.0 实际发布包 engines）及 npm。没有 MCP 入口、启动 hooks 或后台安装器，插件加载不会启动 Node。每次实际调用启动短命命令并在完成后退出；--list/--help 完全本地，不联网或准备依赖。

默认超时 120 秒，RESEARCH_TOOLS_TIMEOUT_MS 可设 1–180000 毫秒；输入和单个官方响应上限 8 MiB。错误和返回值脱敏，子进程 stderr 不向会话转发。取消和终止信号停止本次等待并清理自己启动的子进程。开启三个 MCP 包会常驻三个 Node 网关；实际使用 Fetch 还会增加官方 Python 后端及可能的 uvx 进程。

[官方 CLI](https://context7.com/docs/clients/cli)、[固定发布包](https://registry.npmjs.org/ctx7/0.6.0)。首次调用使用 npm --prefix 安装 ctx7@0.6.0（--ignore-scripts），之后直接 Node 运行官方入口；不执行 login/setup。runtime 默认位于 CODEX_HOME/context7-codex/runtime（fallback ~/.codex），包缓存和官方支持的 XDG 凭据/状态均隔离在该目录。只用 wx 创建本包空凭据文件，不覆盖已有文件；实际命令通过 CONTEXT7_API_KEY 接收私有 JSON 密钥，CTX7_TELEMETRY_DISABLED=1。官方包验证需要 npm 在 Node 发行版或 PATH 中可定位；缺失时返回安装说明。

若同时安装合并版 Research Tools，请只启用合并版或对应独立包，避免工具重复。

## 维护

本包由 research-tools-codex 0.1.4 的 packaging/generate.cjs 生成；维护源是 engine，包内运行文件均为自包含副本。更新维护源后在维护源目录运行生成器，再运行 npm test 检查一致性和独立性。生成器只删除旧 .generated.json 记录且哈希未改的过期生成文件；未知文件、链接和人工修改均停止更新。
