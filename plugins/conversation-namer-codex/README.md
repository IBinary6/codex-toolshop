# Conversation Namer for Codex

为 Codex 会话生成统一、适合侧边栏阅读的标题，同时严格保持项目名称和会话组织不变。

## 安装

```text
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
codex plugin add conversation-namer-codex@codex-toolshop
```

插件需要 Node.js 18 或更高版本，支持 Windows 和 macOS。安装后请在 Codex 中信任插件 hooks，并新建会话使自动命名生效。

## 自动命名

新会话以 `startup` 启动时，hook 只向当前主模型注入一次命名规则，不会自行分类或调用标题接口。每个新建的 Codex 主任务都必须经过这道命名 gate：主模型理解首条请求到足以确定核心主题后，立即读取会话的 `createdAt` 并调用标题接口；完成命名或因工具不可用、主题确实无法判断而安全跳过后，才开始用户要求的主任务，不能等到最终回复，也不能因为请求短、简单或已经可以动手而省略。

```text
MMDD｜TYPE｜Topic
```

默认使用 `FEA / DES / FIX / OPT / REL / EXP / DOC / RES` 英文类型代码；只有首条请求明确要求中文类型时才使用中文标签。无法可靠判断主题时不会改名。已有 assistant turn、已经显式改过标题、恢复、清空或压缩上下文时均不会再次执行自动命名。

自动模式只允许修改当前 Codex 主任务的标题；目标标题已与当前标题完全相同时不会重复写入。它不会修改项目名、会话内容、项目归属、顺序、固定、归档状态、其它任务或 sidebar 外的 subagent。若首条请求本身要求批量规范当前项目的标题，则自动模式先让位给下方的确认流程。

## 批量规范当前项目

在 Codex 中说：

```text
按默认英文类型规范当前 Codex 项目的会话标题
使用中文类型规范当前 Codex 项目的会话标题
```

`conversation-title-manager` skill 会先读取当前会话所属的项目，只预览同一项目中的标题。任何修改前它只显示 `Before / After` 两列表格并等待确认；确认后才逐项复查并改名。

## 限制

- 自动命名依赖 Codex App 提供 `read_thread` 与 `set_thread_title` 工具；工具不可用时会安全跳过。
- 标题语义和 `read_thread` / `set_thread_title` 调用均由当前主模型负责，hook 只注入规则，不做关键词分类，也不会等到最终回复才触发。
- 内置自动标题与显式标题的最终时序由 Codex App 决定；若 App 在稍后再次生成标题，可手动使用批量 skill 重新规范。
