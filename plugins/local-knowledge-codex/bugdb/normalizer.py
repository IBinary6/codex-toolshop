"""错误文本归一化，保持 Claude BugDB 的检索兼容语义。"""

import re

RULES = [
    (re.compile(r"[A-Za-z]:\\[\w\\.\-\s]+"), ""),
    (re.compile(r"/[\w/.\-]+\.\w+"), ""),
    (re.compile(r"\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}[:\d.]*"), ""),
    (re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"), ""),
    (re.compile(r"\b[A-Za-z_][\w\-]*\.[a-zA-Z]{1,5}\b"), ""),
    (re.compile(r"[:(]\d+[,\:\d]*[):]?"), ""),
    (re.compile(r"\bline\s+\d+", re.IGNORECASE), ""),
    (re.compile(r"0x[0-9A-Fa-f]{4,16}"), ""),
    (re.compile(r"\s+"), " "),
]

KNOWN_PHRASES = [
    "unresolved external symbol", "undefined reference", "cannot convert",
    "no matching function", "access violation", "segmentation fault",
    "module not found", "no module named",
]

_ERROR_CODE_RE = re.compile(r"[A-Z]+\d{3,5}|error\[E\d+\]")
_SYMBOL_RE = re.compile(r"[\w:]+(?:::[\w]+)+|__\w+")


def normalize(raw: str) -> str:
    """清洗路径、行号、地址等易变部分。

    Example:
        >>> normalize("C:/proj/x.cpp(42): error LNK2001")
        'error LNK2001'
    """
    if not raw:
        return ""
    value = str(raw)
    for pattern, replacement in RULES:
        value = pattern.sub(replacement, value)
    return value.strip()


def extract_keywords(normalized: str) -> str:
    """提取错误码、命名空间符号和常见错误短语。"""
    if not normalized:
        return ""
    values: list[str] = []
    values.extend(_ERROR_CODE_RE.findall(normalized))
    values.extend(_SYMBOL_RE.findall(normalized))
    lower = normalized.lower()
    values.extend(phrase for phrase in KNOWN_PHRASES if phrase in lower)
    if not values:
        return normalized.strip()
    return " ".join(dict.fromkeys(values))
