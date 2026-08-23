"""Local Knowledge 的值对象与可序列化记录。"""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class KnowledgeItem:
    """一条写入新知识表的记录。

    Example:
        >>> item = KnowledgeItem(1, "note", "a", "", "text", (), (),
        ...                      "global", "", "manual", "user_asserted",
        ...                      "normal", "active", 1, "", "")
        >>> item.to_dict()["id"]
        1
    """

    id: int
    kind: str
    canonical_key: str
    title: str
    content: str
    cues: tuple[str, ...]
    tags: tuple[str, ...]
    scope_kind: str
    scope_key: str
    recall_policy: str
    authority: str
    sensitivity: str
    status: str
    revision: int
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        """转换为 JSON 可编码的字典；例如结果始终包含 ``source``。"""
        return {
            "id": self.id,
            "source": "local_knowledge",
            "kind": self.kind,
            "canonical_key": self.canonical_key,
            "title": self.title,
            "content": self.content,
            "cues": list(self.cues),
            "tags": list(self.tags),
            "scope_kind": self.scope_kind,
            "scope_key": self.scope_key,
            "recall_policy": self.recall_policy,
            "authority": self.authority,
            "sensitivity": self.sensitivity,
            "status": self.status,
            "revision": self.revision,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }
