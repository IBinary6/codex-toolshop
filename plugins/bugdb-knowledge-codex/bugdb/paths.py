"""Codex BugDB 路径解析。

Codex 端默认直接打开 Claude BugDB 的兼容路径，避免迁移后产生第二份
知识库。``BUGDB_HOME`` 仍可用于测试或显式指定另一个共享数据库。
"""

import json
import os
from pathlib import Path

_config_cache: dict | None = None


def get_bugdb_home() -> Path:
    """返回 Codex BugDB 数据目录。

    Example:
        ``BUGDB_HOME=/tmp/bugs`` 时返回 ``/tmp/bugs``。
    """
    override = os.environ.get("BUGDB_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    claude_home = os.environ.get("CLAUDE_HOME", "").strip()
    if claude_home:
        return Path(claude_home).expanduser() / "bugdb"
    return Path.home() / ".claude" / "bugdb"


def get_config_file() -> Path:
    """返回 Codex BugDB 配置文件路径。"""
    return get_bugdb_home() / "config.json"


def read_config() -> dict:
    """读取配置；文件不存在或损坏时返回空字典。"""
    global _config_cache
    if _config_cache is not None:
        return _config_cache
    try:
        _config_cache = json.loads(get_config_file().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        _config_cache = {}
    return _config_cache


def _clear_config_cache() -> None:
    """清理进程内配置缓存，供测试隔离使用。"""
    global _config_cache
    _config_cache = None


def get_db_path(explicit: Path | str | None = None) -> Path:
    """按显式参数、环境变量、配置和默认值解析 SQLite 路径。"""
    if explicit is not None and str(explicit):
        return Path(explicit).expanduser()
    override = os.environ.get("BUGDB_HOME", "").strip()
    if override:
        return Path(override).expanduser() / "bugs.db"
    configured = read_config().get("db_path")
    if configured and str(configured).strip():
        return Path(str(configured)).expanduser()
    return get_bugdb_home() / "bugs.db"


def get_log_path() -> Path:
    """解析操作日志路径。"""
    override = os.environ.get("BUGDB_HOME", "").strip()
    if override:
        return Path(override).expanduser() / "bugdb.log"
    configured = read_config().get("log_path")
    if configured and str(configured).strip():
        return Path(str(configured)).expanduser()
    return get_bugdb_home() / "bugdb.log"


def get_legacy_claude_db_path() -> Path:
    """返回默认 Claude BugDB SQLite 路径，不创建或修改该路径。"""
    claude_home = os.environ.get("CLAUDE_HOME", "").strip()
    if claude_home:
        return Path(claude_home).expanduser() / "bugdb" / "bugs.db"
    return Path.home() / ".claude" / "bugdb" / "bugs.db"
