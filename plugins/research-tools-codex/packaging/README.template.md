# {{DISPLAY_NAME}} for Codex

版本 {{PACKAGE_VERSION}}。安装后在 Codex 插件页面独立启停。此包只暴露 {{TOOLS}}，不依赖其他插件是否安装。

{{USAGE}}

{{INVOCATION}}

{{CONFIG}}

## 独立私有配置

默认位置是 `~/.codex/{{PLUGIN_NAME}}/config.json`；设置 CODEX_HOME 时使用其 `{{PLUGIN_NAME}}/config.json`。可用 `{{OVERRIDE_ENV}}` 指定绝对文件路径。配置模板是 `{{TEMPLATE}}`，见 [config.example.json](config.example.json)。此包只读取自己的配置；合并版的 RESEARCH_TOOLS_CONFIG 对本包无效。

运行 `node scripts/setup.cjs` 仅在文件不存在时创建；`node scripts/setup.cjs --doctor` 只显示本插件的路径与脱敏状态。重装和升级不覆盖已有配置，每次调用重新读取 JSON。不要在命令行、会话或日志中粘贴密钥。

## 运行边界

{{BOUNDARY}}

默认超时 120 秒，RESEARCH_TOOLS_TIMEOUT_MS 可设 1–180000 毫秒；输入和单个官方响应上限 8 MiB。错误和返回值脱敏，子进程 stderr 不向会话转发。取消和终止信号停止本次等待并清理自己启动的子进程。开启三个 MCP 包会常驻三个 Node 网关；实际使用 Fetch 还会增加官方 Python 后端及可能的 uvx 进程。

{{SOURCES}}

若同时安装合并版 Research Tools，请只启用合并版或对应独立包，避免工具重复。

## 维护

本包由 research-tools-codex {{ENGINE_VERSION}} 的 packaging/generate.cjs 生成；维护源是 engine，包内运行文件均为自包含副本。更新维护源后在维护源目录运行生成器，再运行 npm test 检查一致性和独立性。生成器只删除旧 .generated.json 记录且哈希未改的过期生成文件；未知文件、链接和人工修改均停止更新。
