"""中性本地知识库的公共入口。

物理 SQLite 文件仍然可以与旧记录共享，但新功能只写入自己的表，避免
改变旧客户端对 ``knowledge`` 表的严格枚举约束。
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
