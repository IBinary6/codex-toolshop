"""KnowledgeRecord 的 JSON 和文本格式化。"""

import json

from .models import KnowledgeRecord


def record_to_dict(record: KnowledgeRecord) -> dict:
    """把记录转换成 JSON 友好的字典。"""
    value = {
        "id": record.id,
        "entry_kind": record.entry_kind.value,
        "category": record.category.value,
        "key_pattern": record.key_pattern,
        "context": record.context,
        "cause": record.cause,
        "content": record.content,
        "action_steps": list(record.action_steps),
        "title": record.title,
        "language": record.language,
        "project_type": record.project_type,
        "tags": list(record.tags),
        "confidence": record.confidence,
        "usage_count": record.usage_count,
        "success_count": record.success_count,
        "status": record.status.value,
        "replaced_by_id": record.replaced_by_id,
        "valid_for": record.valid_for,
        "deprecation_note": record.deprecation_note,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
    }
    if record.replacement_hint is not None:
        value["replacement_id"] = record.replacement_hint.id
        value["replacement_content"] = record.replacement_hint.content
    return value


def record_to_json(record: KnowledgeRecord) -> str:
    """序列化单条记录。"""
    return json.dumps(record_to_dict(record), ensure_ascii=False, indent=2)


def results_to_json(results: list[KnowledgeRecord]) -> str:
    """序列化结果列表。"""
    return json.dumps({"results": [record_to_dict(item) for item in results]},
                      ensure_ascii=False, indent=2)


def results_to_text(results: list[KnowledgeRecord]) -> str:
    """以便于人工阅读的格式显示结果。"""
    if not results:
        return "(no results)"
    lines: list[str] = []
    for record in results:
        lines.append(f"#{record.id} [{record.entry_kind.value}/{record.category.value}] "
                     f"confidence={record.confidence} status={record.status.value}")
        lines.append(f"  pattern: {record.key_pattern}")
        lines.append(f"  content: {record.content}")
        for index, step in enumerate(record.action_steps, 1):
            lines.append(f"    {index}. {step}")
        if record.replacement_hint is not None:
            lines.append(f"  -> replaced by #{record.replacement_hint.id}: "
                         f"{record.replacement_hint.content}")
        lines.append("")
    return "\n".join(lines)


def record_to_text(record: KnowledgeRecord) -> str:
    """以文本格式显示单条记录。"""
    return results_to_text([record])


def stats_to_json(stats: dict) -> str:
    """序列化统计信息。"""
    return json.dumps(stats, ensure_ascii=False, indent=2)


def stats_to_text(stats: dict) -> str:
    """以排序后的键值显示统计信息。"""
    return "\n".join(f"{key}: {value}" for key, value in sorted(stats.items()))


def record_to_summary(record: KnowledgeRecord, content_limit: int = 80) -> dict:
    """生成不会过度占用上下文的记录摘要。"""
    content = record.content or ""
    if len(content) > content_limit:
        content = content[:content_limit] + "..."
    return {
        "id": record.id,
        "entry_kind": record.entry_kind.value,
        "category": record.category.value,
        "key_pattern": record.key_pattern,
        "content": content,
        "confidence": record.confidence,
        "language": record.language,
        "tags": list(record.tags),
    }


def search_results_to_json(results: list[KnowledgeRecord], fallback: list | None = None) -> str:
    """序列化主结果，并可选附带邻区兜底摘要。"""
    payload = {"results": [record_to_dict(item) for item in results]}
    if fallback:
        payload["fallback"] = True
        payload["fallback_results"] = [record_to_summary(item) for item in fallback]
    return json.dumps(payload, ensure_ascii=False, indent=2)


def search_results_to_text(results: list[KnowledgeRecord], fallback: list | None = None) -> str:
    """以文本显示搜索结果和可选的邻区兜底。"""
    if results:
        return results_to_text(results)
    if not fallback:
        return "(no results)"
    lines = ["[BUGDB_FALLBACK] 没有精确命中，以下是可能相关的历史记录：", ""]
    for item in fallback:
        summary = record_to_summary(item)
        lines.append(f"#{summary['id']} [{summary['entry_kind']}/{summary['category']}] "
                     f"confidence={summary['confidence']} language={summary['language']}")
        lines.append(f"  pattern: {summary['key_pattern']}")
        lines.append(f"  content: {summary['content']}")
        lines.append("")
    return "\n".join(lines)


def explore_to_json(results: list[KnowledgeRecord], query: str, filters: dict) -> str:
    """序列化 explore 结果。"""
    return json.dumps({
        "total": len(results), "query": query, "filters": filters,
        "results": [record_to_summary(item, 120) for item in results],
    }, ensure_ascii=False, indent=2)


def explore_to_text(results: list[KnowledgeRecord], query: str, filters: dict) -> str:
    """以文本显示 explore 结果。"""
    if not results:
        return "(no results)"
    lines = [f"# explore query={query!r} filters={filters} total={len(results)}", ""]
    for item in results:
        summary = record_to_summary(item, 120)
        lines.append(f"#{summary['id']} [{summary['entry_kind']}/{summary['category']}] "
                     f"confidence={summary['confidence']} language={summary['language']} "
                     f"tags={','.join(summary['tags']) if summary['tags'] else '-'}")
        lines.append(f"  pattern: {summary['key_pattern']}")
        lines.append(f"  content: {summary['content']}")
        lines.append("")
    return "\n".join(lines)
