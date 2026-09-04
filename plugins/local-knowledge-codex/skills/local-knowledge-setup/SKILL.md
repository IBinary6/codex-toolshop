---
name: local-knowledge-setup
description: 检查 Local Knowledge 所需的 Python 运行时、SQLite 数据库、全文索引和 CLI 可用性。环境缺失、SessionStart 提示或本地知识无法召回时使用。
---

# Local Knowledge setup

Local Knowledge 只依赖 Python 3.11+ 标准库，不需要安装 Python 包。依次运行：

```text
node "<plugin-root>/scripts/python-launcher.cjs" -c "import sys; print(sys.version)"
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json stats
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json recall --query "local knowledge smoke test" --explicit --limit 1
```

launcher 会验证显式 `LOCAL_KNOWLEDGE_PYTHON`/`BUGDB_PYTHON`，否则在 macOS 尝试 `python3`、`python`，在 Windows 额外尝试 `py -3`。环境变量只填写 Python 可执行文件路径，不附加命令行参数。

`stats` 应返回当前 SQLite 路径、新通用知识数量和历史错误方案数量。`schema.knowledge_items_fts_mode` 为 `trigram` 或 `unicode61` 时使用 FTS5，为 `like` 时表示当前 Python 的 SQLite 不含 FTS5、已安全降级。空查询结果和 `like` 降级本身不是环境错误；进程非零退出、基础 schema 缺失或 JSON 无法解析才是失败。

Python 不可用时只报告版本和安装要求，不自动修改系统 Python。数据库路径保持旧版兼容；除非用户明确指定迁移来源，不创建额外副本。
