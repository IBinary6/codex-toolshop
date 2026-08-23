"""BugDB 检索策略：关键词、全文回退和邻区兜底。"""

from . import normalizer
from .db import BugDB
from .exceptions import RecordNotFound
from .models import KnowledgeRecord, Status

_OVERFETCH_FACTOR = 3


def search(db: BugDB, query: str, language: str | None = None,
           include_deprecated: bool = False, limit: int = 3) -> list[KnowledgeRecord]:
    """先检索 key_pattern，再回退到全文字段。

    Example:
        ``search(db, "LNK2001 unresolved external")`` 会优先命中错误关键词。
    """
    if not query or not query.strip():
        return []
    normalized = normalizer.normalize(query)
    keywords = normalizer.extract_keywords(normalized)
    statuses = ["active"] + (["deprecated"] if include_deprecated else [])
    results = db.fts_search(["key_pattern"], keywords, statuses, language,
                            limit * _OVERFETCH_FACTOR)
    if not results:
        results = db.fts_search(["context", "cause", "content"], normalized,
                                statuses, language, limit * _OVERFETCH_FACTOR)
    results.sort(key=lambda item: (item.confidence, item.success_count), reverse=True)
    for record in results:
        if record.status == Status.DEPRECATED and record.replaced_by_id:
            try:
                record.replacement_hint = db.get(record.replaced_by_id)
            except RecordNotFound:
                record.replacement_hint = None
    return results[:limit]


def _guess_category_from_query(query: str) -> str | None:
    """从错误文本保守推断邻区分类。"""
    hints = (
        ("lnk", "link"), ("unresolved external", "link"),
        ("undefined reference", "link"), ("linker", "link"),
        ("error c", "compile"), ("compile", "compile"),
        ("error e", "compile"), ("access violation", "runtime"),
        ("segfault", "runtime"), ("segmentation fault", "runtime"),
        ("runtime", "runtime"), ("modulenotfounderror", "import"),
        ("no module named", "import"), ("importerror", "import"),
        ("typeerror", "type"), ("cmake error", "build"),
        ("ninja: build stopped", "build"), ("msbuild", "build"),
        ("make: ***", "build"),
    )
    lower = (query or "").lower()
    for needle, category in hints:
        if needle in lower:
            return category
    return None


def fallback_neighborhood(db: BugDB, query: str, language: str | None = None,
                          limit: int = 5) -> list[KnowledgeRecord]:
    """无精确命中时返回同分类或同语言的活跃记录。"""
    category = _guess_category_from_query(query)
    if category:
        rows = db.list_by_filters(category=category, language=language,
                                  statuses=["active"], limit=limit)
        if rows:
            return rows
    if language:
        rows = db.list_by_filters(language=language, statuses=["active"], limit=limit)
        if rows:
            return rows
    return db.list_by_filters(statuses=["active"], limit=limit)


def explore(db: BugDB, query: str = "", language: str | None = None,
            category: str | None = None, entry_kind: str | None = None,
            tags: list[str] | None = None, limit: int = 20) -> list[KnowledgeRecord]:
    """以 FTS OR + LIKE 子串方式做宽松联想检索。"""
    statuses = ["active"]
    columns = ["key_pattern", "context", "cause", "content", "tags"]
    if not query or not query.strip():
        return db.list_by_filters(category=category, language=language,
                                  entry_kind=entry_kind, tags_any=tags,
                                  statuses=statuses, limit=limit)
    normalized = normalizer.normalize(query)
    keywords = normalizer.extract_keywords(normalized) or normalized
    seen: dict[int, KnowledgeRecord] = {}
    try:
        rows = db.fts_search(columns, keywords, statuses, language, limit * 2)
    except Exception:
        rows = []
    for record in rows:
        if record.id is not None:
            seen[record.id] = record
    for record in db.like_search(columns, normalized, statuses, language, limit * 2):
        if record.id is not None:
            seen.setdefault(record.id, record)

    def matches(record: KnowledgeRecord) -> bool:
        if category and record.category.value != category:
            return False
        if entry_kind and record.entry_kind.value != entry_kind:
            return False
        if tags:
            own = [tag.lower() for tag in record.tags]
            if not any(tag.lower() in own or any(tag.lower() in item for item in own)
                       for tag in tags):
                return False
        return True

    results = [record for record in seen.values() if matches(record)]
    results.sort(key=lambda item: (item.confidence, item.success_count), reverse=True)
    return results[:limit]


def find_similar(db: BugDB, pattern: str, threshold: float = 0.7,
                 limit: int = 5) -> list[KnowledgeRecord]:
    """查找所有状态的相似记录，供保存前去重。

    ``threshold`` 保留为兼容 CLI 契约；当前 FTS/LIKE 核心没有浮点相似度实现。
    """
    del threshold
    if not pattern or not pattern.strip():
        return []
    normalized = normalizer.normalize(pattern)
    keywords = normalizer.extract_keywords(normalized)
    return db.fts_search(["key_pattern", "context"], keywords,
                         ["active", "deprecated", "obsolete", "archived"],
                         limit=limit)
