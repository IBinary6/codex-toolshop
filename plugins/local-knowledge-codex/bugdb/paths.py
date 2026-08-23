"""工具中立的共享本地知识路径解析。

Claude Code 与 Codex 默认都使用 ``~/.bugdb``；``LOCAL_KNOWLEDGE_HOME``
用于显式隔离数据库，``BUGDB_HOME`` 作为旧兼容别名。旧 Claude 目录只作为
迁移源，不再作为默认值。
"""

import json
import os
from pathlib import Path

_config_cache: dict | None = None


def _home_override() -> str:
    """返回中性环境变量或旧兼容环境变量指定的数据目录。

    Example:
        ``LOCAL_KNOWLEDGE_HOME`` 与旧变量同时存在时优先使用前者。
    """
    return (os.environ.get("LOCAL_KNOWLEDGE_HOME", "").strip()
            or os.environ.get("BUGDB_HOME", "").strip())


def get_bugdb_home() -> Path:
    """返回共享本地知识数据目录；函数名只为旧调用方兼容。

    Example:
        ``LOCAL_KNOWLEDGE_HOME=/tmp/knowledge`` 时返回该目录。
    """
    override = _home_override()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".bugdb"


def get_config_file() -> Path:
    """返回本地知识兼容配置文件路径。"""
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
    override = _home_override()
    if override:
        return Path(override).expanduser() / "bugs.db"
    configured = read_config().get("db_path")
    if configured and str(configured).strip():
        return Path(str(configured)).expanduser()
    return get_bugdb_home() / "bugs.db"


def get_log_path() -> Path:
    """解析操作日志路径。"""
    override = _home_override()
    if override:
        return Path(override).expanduser() / "bugdb.log"
    configured = read_config().get("log_path")
    if configured and str(configured).strip():
        return Path(str(configured)).expanduser()
    return get_bugdb_home() / "bugdb.log"


def get_legacy_claude_db_path() -> Path:
    """返回旧版 Claude SQLite 路径，不创建或修改该路径。"""
    claude_home = os.environ.get("CLAUDE_HOME", "").strip()
    if claude_home:
        return Path(claude_home).expanduser() / "bugdb" / "bugs.db"
    return Path.home() / ".claude" / "bugdb" / "bugs.db"
