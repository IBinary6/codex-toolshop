"""BugDB 知识记录模型与枚举。"""

from dataclasses import dataclass, field
from enum import Enum


class EntryKind(str, Enum):
    """知识条目类型。"""

    BUG = "bug"
    PRACTICE = "practice"
    TOOL = "tool"
    DECISION = "decision"
    WORKFLOW = "workflow"


class Category(str, Enum):
    """Bug 或知识条目的分类。"""

    COMPILE = "compile"
    LINK = "link"
    RUNTIME = "runtime"
    TYPE = "type"
    IMPORT = "import"
    BUILD = "build"
    CONFIG = "config"
    PRACTICE = "practice"
    TOOL = "tool"
    DECISION = "decision"
    WORKFLOW = "workflow"


class Status(str, Enum):
    """记录生命周期状态。"""

    ACTIVE = "active"
    DEPRECATED = "deprecated"
    OBSOLETE = "obsolete"
    ARCHIVED = "archived"


@dataclass
class KnowledgeRecord:
    """一条可检索知识记录。

    Example:
        >>> KnowledgeRecord().entry_kind.value
        'bug'
    """

    entry_kind: EntryKind = EntryKind.BUG
    category: Category = Category.COMPILE
    key_pattern: str = ""
    cause: str = ""
    content: str = ""
    id: int | None = None
    context: str = ""
    action_steps: list[str] = field(default_factory=list)
    title: str = ""
    language: str = "any"
    project_type: str = "any"
    tags: list[str] = field(default_factory=list)
    confidence: int = 100
    usage_count: int = 0
    success_count: int = 0
    status: Status = Status.ACTIVE
    replaced_by_id: int | None = None
    valid_for: str | None = None
    deprecation_note: str | None = None
    consecutive_failures: int = 0
    created_at: str = ""
    updated_at: str = ""
    replacement_hint: "KnowledgeRecord | None" = None


ErrorType = Category
BugRecord = KnowledgeRecord

_KIND_CATEGORY_RULES: dict[EntryKind, frozenset[Category]] = {
    EntryKind.BUG: frozenset({
        Category.COMPILE, Category.LINK, Category.RUNTIME, Category.TYPE,
        Category.IMPORT, Category.BUILD, Category.CONFIG,
    }),
    EntryKind.PRACTICE: frozenset({Category.PRACTICE}),
    EntryKind.TOOL: frozenset({Category.TOOL}),
    EntryKind.DECISION: frozenset({Category.DECISION}),
    EntryKind.WORKFLOW: frozenset({Category.WORKFLOW}),
}


def validate_kind_category(kind: EntryKind, category: Category) -> str | None:
    """校验条目类型与分类的组合，成功返回 ``None``。"""
    allowed = _KIND_CATEGORY_RULES.get(kind)
    if allowed is None:
        return f"unknown entry_kind: {kind}"
    if category not in allowed:
        values = "/".join(sorted(item.value for item in allowed))
        return (f"entry_kind={kind.value} 不允许 category={category.value}；"
                f"允许的 category：{values}")
    return None
