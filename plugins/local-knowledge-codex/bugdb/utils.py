"""BugDB 使用的无第三方依赖工具函数。"""

import json
from datetime import datetime, timezone


def now_iso() -> str:
    """返回 UTC ISO-8601 秒级时间。

    Example:
        >>> now_iso().endswith("+00:00")
        True
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_json_loads(raw: str):
    """解析 JSON，错误或空值返回 ``None``。

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
    """将步骤列表编码为稳定的 UTF-8 JSON 数组。"""
    return json.dumps(list(values or []), ensure_ascii=False)


def comma_split(raw: str | None) -> list[str]:
    """按逗号拆分标签并去除空白与重复值。"""
    if not raw:
        return []
    result: list[str] = []
    for item in str(raw).split(","):
        value = item.strip()
        if value and value not in result:
            result.append(value)
    return result


def comma_join(values: list[str] | tuple[str, ...] | None) -> str:
    """将标签列表编码为逗号分隔字符串。"""
    return ",".join(comma_split(",".join(str(v) for v in (values or []))))
