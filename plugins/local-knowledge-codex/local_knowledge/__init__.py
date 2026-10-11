"""Public entry point for neutral local knowledge.

The physical SQLite file can still be shared with legacy records, but new features write only to their own tables to avoid
changing the strict enum constraints older clients apply to the ``knowledge`` table.
"""

from .errors import (KnowledgeArgumentError, KnowledgeError,
                     KnowledgeNotFound, SensitiveContentError)
from .storage import KnowledgeBase

__all__ = [
    "KnowledgeArgumentError",
    "KnowledgeBase",
    "KnowledgeError",
    "KnowledgeNotFound",
    "SensitiveContentError",
]
