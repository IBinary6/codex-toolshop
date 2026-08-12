---
name: bugdb-migrate
description: 将 Claude BugDB 的 SQLite 或 JSON 导出安全迁移到 Codex BugDB；默认路径共享时只需验证，无需复制。
---

# BugDB migration

先查看当前路径：

```text
python <plugin-root>/bugdb/cli.py config path --format text
```

Codex 与 Claude Code 默认打开工具中立的 `~/.bugdb/bugs.db`。从旧版
`~/.claude/bugdb/bugs.db` 迁移时执行：

```text
python <plugin-root>/bugdb/cli.py migrate --format text
```

若记录位于独立 SQLite 文件，执行：

```text
python <plugin-root>/bugdb/cli.py migrate --source "<claude-bugs.db>" --format text
```

目标库不存在时使用 SQLite backup 无损复制整个数据库，保留记录 ID、状态、FTS 和
schema；目标库已存在时按 `key_pattern + context` 去重合并。迁移始终以只读模式打开
source，不删除、重写或移动旧库；迁移后用 `stats` 与 `search` 验证目标记录。
