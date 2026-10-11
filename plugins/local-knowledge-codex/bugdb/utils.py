"""Dependency-free utilities for BugDB."""

import json
from datetime import datetime, timezone


def now_iso() -> str:
    """Return a UTC ISO-8601 timestamp with second precision.

    Example:
        >>> now_iso().endswith("+00:00")
        True
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_json_loads(raw: str):
    """Parse JSON, returning ``None`` on error or empty input.

    Example:
        >>> safe_json_loads("[1]")
        [1]
    """
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None


def to_json_array(values: list | tuple | None) -> str:
    """Encode steps as a stable UTF-8 JSON array."""
    return json.dumps(list(values or []), ensure_ascii=False)


def comma_split(raw: str | None) -> list[str]:
    """Split comma-separated tags and remove blanks and duplicates."""
    if not raw:
        return []
    result: list[str] = []
    for item in str(raw).split(","):
        value = item.strip()
        if value and value not in result:
            result.append(value)
    return result


def comma_join(values: list[str] | tuple[str, ...] | None) -> str:
    """Encode tags as a comma-separated string."""
    return ",".join(comma_split(",".join(str(v) for v in (values or []))))
