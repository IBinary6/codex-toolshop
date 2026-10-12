"""BugDB search strategy: keywords, full-text fallback, and nearby-category fallback."""

from . import normalizer
from .db import BugDB
from .exceptions import RecordNotFound
from .models import KnowledgeRecord, Status

_OVERFETCH_FACTOR = 3


def search(db: BugDB, query: str, language: str | None = None,
           include_deprecated: bool = False, limit: int = 3) -> list[KnowledgeRecord]:
    """Search key_pattern first, then fall back to full-text fields.

    Example:
        ``search(db, "LNK2001 unresolved external")`` prioritizes the error keyword.
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

