# Conversation Namer for Codex

为 Codex 会话生成统一、适合侧边栏阅读的标题，同时严格保持项目名称和会话组织不变。

## 安装

```text
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
codex plugin add conversation-namer-codex@codex-toolshop
```

插件需要 Node.js 18 或更高版本，以及已登录、可从 PATH 启动的 `codex` CLI（当前接口按 0.151.0 验证）。支持 Windows 和 macOS。安装或更新后请在 Codex 中信任变更后的 hooks，并新建会话使自动命名生效。

## 自动命名

新会话收到第一条用户消息后，插件在后台调用轻量模型起名。桌面任务通过当前任务的 `mcp__codex_app__set_thread_title` 写回标题，让持久层与界面一起更新；CLI 任务通过 App Server 写回。主模型不参与起名，不读取 skill、展示预览或等待用户确认，只在标题就绪后执行一次桌面写回工具。

```text
MMDD｜TYPE｜Topic
```

模型只返回类型与主题；主题跟随首条消息的语言，日期由程序读取会话 `createdAt`，按 `Asia/Shanghai` 计算。默认使用 `FEA / DES / FIX / OPT / REL / EXP / DOC / RES` 英文类型代码；只有首条请求明确要求中文类型时才使用中文标签。

每个 startup 会话只领取一次命名任务，后续消息、重复 hook、恢复、清空或压缩不会重跑。启动时后台观察当前任务的首轮输入，普通 `UserPromptSubmit` 同时保留为直接入口；两条路径共享原子领取标记，不会重复调用命名模型。由 `create_thread` 建立的任务，其首条请求可能是 `codex_app.create_thread` 的委派消息，而不是普通用户消息，观察器会从宿主的明确封装中取出请求。只读取当前任务首轮，不使用标题、preview 或其他任务内容猜测。

开场进度说明不影响命名。首次写回以插件生成结果为准，宿主在生成期间先设置默认标题不会导致跳过。长任务在下一次工具返回时通过 `PostToolUse` 提交写回请求；没有工具调用的短回答在 `Stop` 时提交。两条交付入口共用独立的原子标记，每个任务最多请求一次桌面写回，其他插件触发的续轮不会重复起名或交付。自动模式只处理当前主任务标题，不修改项目名、会话内容或其他任务。

桌面交付只把生成好的标题作为 JSON 字符串传给宿主工具，不让主模型改写。`PostToolUse` 核对工具名、当前任务 ID、标题以及成功回包，全部匹配才标记完成；另一个 App Server 读回相同标题不算桌面确认。当前用户明确禁止改名或工具调用时遵从该要求，不由 hook 扩大授权。

问候、简短问题和会话管理请求也会生成标题，不因主题宽泛而跳过。用户明确要求不要改名时才按其要求跳过；给出完整指定标题时使用原文。模型仅接收首条消息与短命名规则，临时任务不保存为侧边栏会话，并禁用项目指令、插件 hooks、MCP、记忆和工作工具。缺少有效创建时间时不猜日期。

## 轻量模型与状态

默认从实时 `model/list` 中按 Spark、Mini、Luna 家族顺序选择可用模型，不写死版本号；当前对应 GPT-5.3 Codex Spark → GPT-5.4 Mini → GPT-5.6 Luna。只使用模型声明支持的 `none`、`minimal`、`low` 中最低档位。前一个模型未列入可用目录或不支持低推理档位时，使用后面的模型；没有合适模型时保留原标题。

可在插件 `PLUGIN_DATA/config.json` 中指定模型或超时，缺省无需配置：

```json
{ "model": "auto", "timeoutSeconds": 60 }
```

`model` 可改为当前账号可用的完整模型 ID；`timeoutSeconds` 支持 5–120 秒。配置只影响命名，不修改 Codex 全局模型。复用 CLI 现有登录与 provider 配置，每个新会话至多发起一次命名推理。

`PLUGIN_DATA/sessions/` 保存按会话 ID 哈希索引的状态和原子领取标记，不保存用户消息或服务端诊断：

| 状态 | 含义 |
| --- | --- |
| `pending` | 等待首条请求 |
| `started` | 已领取一次命名推理 |
| `ready` + `delivery: desktop` | 标题已生成，桌面写回尚未确认 |
| `ready` + `desktopSync: requested` | 已请求当前任务调用桌面工具；不等于成功 |
| `done` + `desktopSync: acknowledged` | 桌面工具返回了匹配的任务 ID 和标题 |
| `done`（CLI） | App Server 写入并读回一致 |
| `skipped / failed` | 跳过或失败，没有自动重新推理 |

未提供 `PLUGIN_DATA` 时使用 `$CODEX_HOME/plugins/data/conversation-namer-codex`，`CODEX_HOME` 缺省为用户目录下的 `.codex`。后台进程被强制终止或系统退出时可能停留在 `started`，不代表仍在运行或已经成功。桌面工具不可用、失败或主模型没有执行交付时保持 `ready`，不会伪报 `done`，也不会回退到 UI 自动化、手改数据库或独立 App Server 写标题。

启动观察最多等待 60 秒，使用退避轮询，不调用命名模型。未取得首条请求时结束观察并保留 `pending`，因此用户稍后手动发送首条消息仍可命名。取得请求后，生成和写回另受 `timeoutSeconds` 限制。诊断工具创建的任务时，`pending` 且没有 `.claimed` 表示尚未领取；`started / failed / skipped` 表示已经进入命名链路，不能据此重复发起模型调用。

短回答先结束而命名仍在进行时，`Stop` 最多等待一次，等待上限是配置超时加 5 秒（默认 65 秒、最大 125 秒）。超时后正常放行，不无限续轮；迟到的已生成标题可以在后续工具返回或结束时交付，命名推理不会重跑。

## 限制

- 自动命名依赖 CLI 的 `model/list`、`thread/start`、`turn/start`、`thread/read` 与 `thread/name/set` 接口；缺少 CLI、登录或接口时会失败并保留原标题。
- 桌面写回依赖当前任务能调用 `mcp__codex_app__set_thread_title`。App Server 来源为 `vscode` 的桌面/编辑器任务采用此路径；编辑器宿主若没有该工具，标题交付保持未确认。CLI 沿用持久层写回。没有经过桌面显示验收时，不把 API 成功声称为 UI 已验证。
- 桌面交付会增加一次主任务工具调用；无工具短回答可能增加一次 Stop 续轮。它不读取 skill，也不重新运行命名模型。首次交付会覆盖此时的默认或手动标题；完成后不再改动标题。
- CLI 升级插件后，正在运行的桌面进程可能仍缓存旧插件路径。若命令行已经安装新版，而新任务的 hook 或 MCP 报旧路径不存在，应完全退出并重开 App 后检查自然触发；手动运行 hook 通过不能替代这项验收。
- 超过 20,000 字符或无文本的首条消息跳过自动命名。
