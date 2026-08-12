---
name: bugdb-setup
description: 检查 Codex BugDB 的 Python 运行环境、共享数据库路径和 CLI 可用性。
---

# BugDB setup

BugDB 只依赖 Python 3.11+ 标准库，不需要 pip 安装。按顺序运行：

```text
python -c "import sys; print(sys.version)"
python <plugin-root>/bugdb/cli.py stats --format text
python <plugin-root>/bugdb/cli.py config path --format text
```

如果 Python 不可用，报告环境问题并等待用户安装；不要由插件自动修改系统 Python。
数据库默认位于工具中立的 `~/.bugdb/bugs.db`，由 Claude Code 与 Codex 共享。若只有
旧版 `~/.claude/bugdb/bugs.db`，先运行 `bugdb-migrate`，再验证记录数与历史查询。
