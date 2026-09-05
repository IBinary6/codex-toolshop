---
name: local-knowledge-migrate
description: 验证或迁移旧版本地 SQLite 知识记录到当前 Local Knowledge 数据库。仅在用户要求迁移、导入旧记录或排查共享数据路径时使用。
---

# Local Knowledge migrate

当前版本继续使用原有共享 SQLite 文件，因此升级插件通常无需复制数据。先运行：

```text
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json stats --read-only
```

只有记录仍位于旧目录或独立数据库时，才调用兼容迁移入口：

```text
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" migrate --source "<旧数据库绝对路径>" --format text
```

未提供 `--source` 时，兼容迁移器只检查已知旧目录。迁移必须只读打开来源，不删除、移动或覆盖来源；目标已存在时按旧记录的精确键去重。完成后重新运行 `stats`，并分别用典型错误和通用知识查询验证。

该流程只迁移旧格式记录；新表已在同一数据库中时不需要再次导入。
