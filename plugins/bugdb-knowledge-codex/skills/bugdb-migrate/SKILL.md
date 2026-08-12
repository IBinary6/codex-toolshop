---
name: bugdb-migrate
description: 将 Claude BugDB 的 SQLite 或 JSON 导出安全迁移到 Codex BugDB；默认路径共享时只需验证，无需复制。
---

# BugDB migration

先查看当前路径：

```text
python <plugin-root>/bugdb/cli.py config path --format text
```

Codex 默认直接打开 `~/.claude/bugdb/bugs.db`。如果当前 Claude 数据库就是这个路径，
无需执行复制，运行下面的命令只会报告 `shared=true`：

```text
python <plugin-root>/bugdb/cli.py migrate --format text
```

若记录位于独立 SQLite 文件，执行：

```text
python <plugin-root>/bugdb/cli.py migrate --source "<claude-bugs.db>" --format text
```

迁移代码以只读模式打开 source，支持 Claude `bugs` v1 和 `knowledge` v3 表，写入目标
时按 `key_pattern + context` 去重。不要删除、重写或移动 source；迁移后用 `stats` 与
`search` 验证目标记录。
