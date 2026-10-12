"""Build validated knowledge records from CLI arguments or imported dictionaries."""

from bugdb import normalizer, utils
from bugdb.models import Category, EntryKind, KnowledgeRecord, Status, validate_kind_category


def parse_steps(raw: str | None) -> list:
    """Parse an action_steps JSON array; raise ValueError for invalid input."""
    if raw is None or not str(raw).strip():
        return []
    value = utils.safe_json_loads(raw)
    if not isinstance(value, list):
        raise ValueError("--action-steps must be a JSON array")
    return value


def new_record(data: dict) -> KnowledgeRecord:
    """Convert CLI or imported dictionaries to validated record models."""
    kind = EntryKind(data.get("entry_kind", "bug"))
    category = Category(data.get("category") or data.get("error_type", "compile"))
    error = validate_kind_category(kind, category)
    if error:
        raise ValueError(error)
    context = data.get("context") or data.get("error_message", "")
    pattern = data.get("key_pattern") or data.get("error_pattern")
    if not pattern:
        pattern = normalizer.extract_keywords(normalizer.normalize(context))
    if not pattern:
        raise ValueError("key_pattern is empty (provide context or key_pattern)")
    action_steps = data.get("action_steps")
    if action_steps is None:
        action_steps = data.get("solution_steps", [])
    if isinstance(action_steps, str):
        action_steps = parse_steps(action_steps)
    if not isinstance(action_steps, list):
        raise ValueError("action_steps must be a JSON array")
    tags = data.get("tags", [])
    if isinstance(tags, str):
        tags = utils.comma_split(tags)
    return KnowledgeRecord(
        id=data.get("id"), entry_kind=kind, category=category,
        key_pattern=str(pattern), context=context,
        cause=data.get("cause") or data.get("root_cause", ""),
        content=data.get("content") or data.get("solution", ""),
        action_steps=list(action_steps), title=data.get("title", ""),
        language=data.get("language", "any"), project_type=data.get("project_type", "any"),
        tags=list(tags), confidence=int(data.get("confidence", 100)),
        usage_count=int(data.get("usage_count", 0)),
        success_count=int(data.get("success_count", 0)),
        status=Status(data.get("status", "active")),
        replaced_by_id=data.get("replaced_by_id") or data.get("replaces_id"),
        valid_for=data.get("valid_for"), deprecation_note=data.get("deprecation_note"),
        consecutive_failures=int(data.get("consecutive_failures", 0)),
        created_at=data.get("created_at", ""), updated_at=data.get("updated_at", ""),
    )
