---
name: bugdb-lookup
description: 查询本地 BugDB 以避免重复试错。用户描述、粘贴或工具输出出现编译、链接、运行时、构建、CI 错误或非正式失败信息时务必先查询一次；无命中时继续正常排查，不阻塞主线。
---

# BugDB lookup

## 触发条件

满足任一条件就调用，无需用户显式要求：

1. Bash 等工具输出包含错误码、异常栈、崩溃、找不到依赖或构建失败。
2. 用户消息描述“报错、失败、找不到、崩溃、无法启动”等代码或工程问题。

纯代码编写、概念解释和没有错误上下文的用法咨询不触发。

## 执行流程

### 1. 查询一次

```text
python <plugin-root>/bugdb/cli.py search --query "<原始错误>" --language <语言> --format json
```

其中 `<plugin-root>` 是本 skill 所在插件目录（从 `skills/bugdb-lookup/SKILL.md` 向上两级）。
Codex 默认直接使用 `~/.claude/bugdb/bugs.db`，因此已有 Claude 记录无需复制即可查询。

### 2. 解读并验证

- `confidence >= 70` 且 `status=active`：优先按 `action_steps` 尝试，并验证结果。
- 置信度较低：只作参考，不盲从。
- `status=deprecated`：沿 `replaced_by_id` 查看替代方案后再决定。
- 无结果或 CLI/数据库不可用：静默降级到正常排查，不重复改写 query 反复查询。

方案验证后反馈：

```text
python <plugin-root>/bugdb/cli.py feedback --id <id> --result success
python <plugin-root>/bugdb/cli.py feedback --id <id> --result failure
```

### 3. 降级

未命中或方案无效时直接进入正常排查，不得因 BugDB 停顿，也不得改写 query 反复查询。
问题解决后再评估是否调用 `bugdb-record`，避免把猜测写入知识库。

## 跨语言规则

Python 调 C++ 扩展后在原生层崩溃时，`language` 填 `c++`；其它情况以错误栈顶语言为准。
