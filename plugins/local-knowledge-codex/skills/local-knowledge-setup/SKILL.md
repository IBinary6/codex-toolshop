---
name: local-knowledge-setup
description: 检查 Local Knowledge 所需的 Python 运行时、SQLite 数据库、全文索引和 CLI 可用性。环境缺失、SessionStart 提示或本地知识无法召回时使用。
---

# Local Knowledge setup

Local Knowledge 只依赖 Python 3.11+ 标准库，不需要安装 Python 包。依次运行：

```text
python -c "import sys; print(sys.version)"
python <plugin-root>/local_knowledge/cli.py --format json stats
python <plugin-root>/local_knowledge/cli.py --format json recall \
  --query "local knowledge smoke test" --explicit --limit 1
```

`stats` 应返回当前 SQLite 路径、新通用知识数量和历史错误方案数量。空查询结果不是环境错误；进程非零退出、schema/FTS 缺失或 JSON 无法解析才是失败。

Python 不可用时只报告版本和安装要求，不自动修改系统 Python。数据库路径保持旧版兼容；除非用户明确指定迁移来源，不创建额外副本。
