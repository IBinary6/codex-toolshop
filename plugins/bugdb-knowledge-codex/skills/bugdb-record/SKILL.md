---
name: bugdb-record
description: 保存已验证的 Bug 修复、工程实践、工具技巧、架构决策或工作流。用户确认“解决了、跑通了、已修复、通过了、根因已确认、方案定下来了”等结论时务必评估；达到录入门槛后先去重，再写入并验证可检索。
---

# BugDB record

## 触发条件

满足任一条件时评估录入：

1. Bug 修复已经重新构建、测试或运行验证。
2. 发现可复用且非显然的工程实践或工具技巧。
3. 架构决策或稳定工作流已经确定并具有长期价值。

还在排查、只是提出假设或方案仅适用于一次性本机环境时不录入。

## 1. 去重

```text
python <plugin-root>/bugdb/cli.py find-similar --pattern "<错误关键词或知识主题>" --threshold 0.7 --format json
```

按命中状态处理：

- `active`：使用 `update --id <id>` 增强已有记录，不新增。
- `deprecated`：沿 `replaced_by_id` 找最新方案；只有场景确实不同才新增，并用 `--valid-for` 区分。
- `obsolete`：旧方案确认不可用时才新增，并在 `cause` 说明差异。
- `archived`：先 `restore --id <id>`，再 `update`，不重复新增。

## 2. 录入

没有相似记录时执行：

```text
python <plugin-root>/bugdb/cli.py add \
  --entry-kind <bug|practice|tool|decision|workflow> --category <分类> \
  --context "<原始错误或适用背景>" --cause "<根因>" \
  --content "<已验证方案>" --action-steps '["步骤1","步骤2"]' \
  --title "<可选标题>" --language <语言> \
  --project-type <vs|cmake|cargo|npm|makefile|any> --tags "<标签>"
```

`entry-kind` 与 `category` 的合法组合：

| entry-kind | category |
| --- | --- |
| `bug` | `compile`、`link`、`runtime`、`type`、`import`、`build`、`config` |
| `practice` | `practice` |
| `tool` | `tool` |
| `decision` | `decision` |
| `workflow` | `workflow` |

`key_pattern` 由 CLI 根据 `context` 自动归一化，不需要手工构造。

## 3. 验证

```text
python <plugin-root>/bugdb/cli.py search --query "<context>" --language <语言> --format json
```

若无法检索到刚录入的记录，报告 normalizer 或索引问题，不能把录入视为成功。

## 录入门槛

默认数据库是 `~/.bugdb/bugs.db`，由 Claude Code 与 Codex 直接共享；不要为 Codex
另建一次性副本。只有复现概率大于 50%、根因和方案明确、验证证据充分的内容才录入；
一次性环境问题或未经验证的猜测不应录入。
