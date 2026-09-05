---
name: local-knowledge-setup
description: 检查 Local Knowledge 所需的 Python 运行时、SQLite 数据库、全文索引和 CLI 可用性。环境缺失、SessionStart 提示或本地知识无法召回时使用。
---

# Local Knowledge setup

Local Knowledge 只依赖 Python 3.11+ 标准库，不需要安装 Python 包。先进行只读诊断：

```text
node "<plugin-root>/scripts/python-launcher.cjs" -c "import sys; print(sys.version)"
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json stats --read-only
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json recall --read-only --query "local knowledge smoke test" --explicit --limit 1
```

launcher 会验证显式 `LOCAL_KNOWLEDGE_PYTHON`/`BUGDB_PYTHON`，否则在 macOS 尝试 `python3`、`python`，在 Windows 额外尝试 `py -3`。环境变量只填写 Python 可执行文件路径，不附加命令行参数。

`stats` 应返回当前 SQLite 路径、新通用知识数量和历史错误方案数量。`schema.knowledge_items_fts_mode` 为 `trigram` 或 `unicode61` 时使用 FTS5，为 `like` 时表示当前 Python 的 SQLite 不含 FTS5、已安全降级。空查询结果和 `like` 降级本身不是环境错误；进程非零退出、基础 schema 缺失或 JSON 无法解析才是失败。

首次使用可能尚无数据库。若当前任务已授权初始化或维护本插件，可运行不带 `--read-only` 的 `stats` 创建新表并修复索引，再重复只读检查；只读审查时只报告缺失。旧 `bugs` 表需要显式维护流程，自动 hook 不迁移。

Python 不可用时，先使用现有可用解释器；确需安装时遵守当前工具策略和授权，不修改系统 Python 的默认指向。数据库路径保持旧版兼容；除非用户指定迁移来源，不创建额外数据库副本。

`LOCAL_KNOWLEDGE_SAVE_HINTS` 控制提示：`verified`（兼容默认）提示显式保存或已验证方案候选，`explicit` 仅提示明确记忆措辞，`off` 关闭保存提示；无效值按 `off`。各模式都保留自动召回，hook 永不直接保存，也不能覆盖宿主的记忆限制。只需在宿主环境设置；无需为每次任务询问。
