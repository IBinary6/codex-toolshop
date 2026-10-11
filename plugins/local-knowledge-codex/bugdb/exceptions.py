"""BugDB domain exceptions."""


class BugDBError(Exception):
    """Base BugDB exception."""


class RecordNotFound(BugDBError):
    """The requested knowledge record does not exist."""


class SchemaMigrationError(BugDBError):
    """SQLite schema migration failed."""
