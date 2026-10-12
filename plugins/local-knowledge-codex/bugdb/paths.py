"""Tool-neutral path resolution for shared local knowledge.

Claude Code and Codex both use ``~/.bugdb`` by default; ``LOCAL_KNOWLEDGE_HOME``
explicitly isolates the database, while ``BUGDB_HOME`` remains a compatibility alias. The old Claude directory is only a
migration source, no longer a default.
"""

import json
import os
from pathlib import Path

_config_cache: dict | None = None


def _home_override() -> str:
    """Return the data directory from the neutral or legacy-compatible environment variable.

    Example:
        Prefer ``LOCAL_KNOWLEDGE_HOME`` when both variables are set.
    """
    return (os.environ.get("LOCAL_KNOWLEDGE_HOME", "").strip()
            or os.environ.get("BUGDB_HOME", "").strip())


def get_bugdb_home() -> Path:
    """Return the shared local knowledge data directory; the function name exists for legacy callers.

    Example:
        Return that directory when ``LOCAL_KNOWLEDGE_HOME=/tmp/knowledge``.
    """
    override = _home_override()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".bugdb"


def get_config_file() -> Path:
    """Return the local knowledge compatibility configuration path."""
    return get_bugdb_home() / "config.json"


def read_config() -> dict:
    """Read configuration; return an empty dictionary if the file is missing or invalid."""
    global _config_cache
    if _config_cache is not None:
        return _config_cache
    try:
        _config_cache = json.loads(get_config_file().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        _config_cache = {}
    return _config_cache


def get_db_path(explicit: Path | str | None = None) -> Path:
    """Resolve the SQLite path from explicit arguments, environment, configuration, and defaults."""
    if explicit is not None and str(explicit):
        return Path(explicit).expanduser()
    override = _home_override()
    if override:
        return Path(override).expanduser() / "bugs.db"
    configured = read_config().get("db_path")
    if configured and str(configured).strip():
        return Path(str(configured)).expanduser()
    return get_bugdb_home() / "bugs.db"


def get_legacy_claude_db_path() -> Path:
    """Return the legacy Claude SQLite path without creating or changing it."""
    claude_home = os.environ.get("CLAUDE_HOME", "").strip()
    if claude_home:
        return Path(claude_home).expanduser() / "bugdb" / "bugs.db"
    return Path.home() / ".claude" / "bugdb" / "bugs.db"
