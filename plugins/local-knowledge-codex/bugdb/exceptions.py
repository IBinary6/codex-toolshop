"""BugDB 领域异常。"""


class BugDBError(Exception):
    """BugDB 基础异常。"""


class RecordNotFound(BugDBError):
    """请求的知识记录不存在。"""


class SchemaMigrationError(BugDBError):
    """SQLite schema 迁移失败。"""
