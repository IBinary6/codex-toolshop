# Conversation Namer for Codex

为 Codex 会话生成统一、适合侧边栏阅读的标题，同时严格保持项目名称和会话组织不变。

## 安装

```text
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
codex plugin add conversation-namer-codex@codex-toolshop
```

插件需要 Node.js 18 或更高版本，以及已登录、可从 PATH 启动的 `codex` CLI（当前接口按 0.151.0 验证）。支持 Windows 和 macOS。安装或更新后请在 Codex 中信任变更后的 hooks，并新建会话使自动命名生效。

## 自动命名

新会话收到第一条用户消息后，插件在后台调用轻量模型起名，再通过 Codex App Server 写回当前会话标题。主模型直接处理用户请求，无需承担命名或等待命名完成。

```text
MMDD｜TYPE｜Topic
```

模型只返回类型与主题；主题跟随首条消息的语言，日期由程序读取会话 `createdAt`，按 `Asia/Shanghai` 计算。默认使用 `FEA / DES / FIX / OPT / REL / EXP / DOC / RES` 英文类型代码；只有首条请求明确要求中文类型时才使用中文标签。

每个 startup 会话只领取一次命名任务，后续消息、重复 hook、恢复、清空或压缩不会重跑。开场进度说明不影响命名。生成前后若发现标题被改动则跳过；相同标题不重复写入，写回后重新读取确认。自动模式只处理当前主任务标题，不修改项目名、会话内容或其他任务。

用户明确要求不要改名、主题不清楚或首条请求要求批量改名时，命名模型返回跳过；给出完整指定标题时使用原文。模型仅接收首条消息与短命名规则，临时任务不保存为侧边栏会话，并禁用项目指令、插件 hooks、MCP、记忆和工作工具。缺少有效创建时间时不猜日期。

## 轻量模型与状态

默认从实时 `model/list` 中按 Spark、Mini、Luna 家族顺序选择可用模型，不写死版本号；当前对应 GPT-5.3 Codex Spark → GPT-5.4 Mini → GPT-5.6 Luna。只使用模型声明支持的 `none`、`minimal`、`low` 中最低档位。前一个模型未列入可用目录或不支持低推理档位时，使用后面的模型；没有合适模型时保留原标题。

可在插件 `PLUGIN_DATA/config.json` 中指定模型或超时，缺省无需配置：

```json
{ "model": "auto", "timeoutSeconds": 60 }
```

`model` 可改为当前账号可用的完整模型 ID；`timeoutSeconds` 支持 5–120 秒。配置只影响命名，不修改 Codex 全局模型。复用 CLI 现有登录与 provider 配置，每个新会话至多发起一次命名推理。

`PLUGIN_DATA/sessions/` 保存按会话 ID 哈希索引的 `pending / started / done / skipped / failed` 状态和原子领取标记，不保存用户消息或服务端诊断。未提供 `PLUGIN_DATA` 时使用 `$CODEX_HOME/plugins/data/conversation-namer-codex`，`CODEX_HOME` 缺省为用户目录下的 `.codex`。失败或超时保留原标题，不阻塞主任务或自动重试。后台进程被强制终止或系统退出时可能停留在 `started`，表示已尝试但结果未确认，不代表仍在运行或已经成功。

## 批量规范当前项目

在 Codex 中说：

```text
按默认英文类型规范当前 Codex 项目的会话标题
使用中文类型规范当前 Codex 项目的会话标题
```

`conversation-title-manager` skill 会先读取当前会话所属的项目，只预览同一项目中的标题。任何修改前它只显示 `Before / After` 两列表格并等待确认；确认后才逐项复查并改名。

## 限制

- 自动命名依赖 CLI 的 `model/list`、`thread/start`、`turn/start`、`thread/read` 与 `thread/name/set` 接口；缺少 CLI、登录或接口时会失败并保留原标题。
- 标题通过独立 App Server 写入并复读验证。桌面已有连接的即时刷新及内置自动标题时序由宿主决定；本地读写成功不等同于桌面 UI 已同步。当前接口没有比较并交换，写前复核只能缩小同时手动改名的竞争窗口。
- 超过 20,000 字符或无文本的首条消息跳过自动命名；用户可使用批量 skill 手动规范。
