"""BugDB SQLite data access layer.

The schema remains compatible with Claude BugDB v3; Codex shares the Claude database by default.
For other migration sources, the CLI reads the source database without writes and uses this module for target writes.
"""

import sqlite3
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path

from . import paths, utils
from .exceptions import RecordNotFound, SchemaMigrationError
from .models import Category, EntryKind, KnowledgeRecord, Status

_COLUMNS = (
    "id, entry_kind, category, key_pattern, context, cause, content, "
    "action_steps, title, language, project_type, tags, confidence, usage_count, "
    "success_count, status, replaced_by_id, valid_for, deprecation_note, "
    "created_at, updated_at, consecutive_failures"
)
_DECAY_FAILURE_THRESHOLD = 3
_DECAY_STEP = 20
_DECAY_FLOOR = 20
_DECAY_SUCCESS_RATE = 0.3


def _migrate_v0_to_v1(conn: sqlite3.Connection) -> None:
    """Create Claude BugDB v1-compatible tables and trigram FTS."""
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS bugs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        error_type TEXT NOT NULL CHECK(error_type IN ('compile','link','runtime','type','import','build','config')),
        error_pattern TEXT NOT NULL,
        error_message TEXT DEFAULT '',
        root_cause TEXT NOT NULL,
        solution TEXT NOT NULL,
        solution_steps TEXT DEFAULT '[]',
        language TEXT DEFAULT 'any',
        project_type TEXT DEFAULT 'any',
        tags TEXT DEFAULT '',
        confidence INTEGER DEFAULT 100 CHECK(confidence BETWEEN 0 AND 100),
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active' CHECK(status IN ('active','deprecated','obsolete','archived')),
        replaces_id INTEGER REFERENCES bugs(id) ON DELETE SET NULL,
        valid_for TEXT,
        deprecation_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bugs_status ON bugs(status);
    CREATE INDEX IF NOT EXISTS idx_bugs_language ON bugs(language);
    CREATE INDEX IF NOT EXISTS idx_bugs_error_type ON bugs(error_type);
    CREATE INDEX IF NOT EXISTS idx_bugs_confidence ON bugs(confidence DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS bugs_fts USING fts5(
        error_pattern, error_message, root_cause, solution, tags,
        content=bugs, content_rowid=id, tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS bugs_fts_insert AFTER INSERT ON bugs BEGIN
        INSERT INTO bugs_fts(rowid, error_pattern, error_message, root_cause, solution, tags)
        VALUES (new.id, new.error_pattern, new.error_message, new.root_cause, new.solution, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS bugs_fts_delete AFTER DELETE ON bugs BEGIN
        INSERT INTO bugs_fts(bugs_fts, rowid, error_pattern, error_message, root_cause, solution, tags)
        VALUES ('delete', old.id, old.error_pattern, old.error_message, old.root_cause, old.solution, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS bugs_fts_update AFTER UPDATE ON bugs BEGIN
        INSERT INTO bugs_fts(bugs_fts, rowid, error_pattern, error_message, root_cause, solution, tags)
        VALUES ('delete', old.id, old.error_pattern, old.error_message, old.root_cause, old.solution, old.tags);
        INSERT INTO bugs_fts(rowid, error_pattern, error_message, root_cause, solution, tags)
        VALUES (new.id, new.error_pattern, new.error_message, new.root_cause, new.solution, new.tags);
    END;
    """)


def _migrate_v1_to_v2(conn: sqlite3.Connection) -> None:
    """Add the consecutive failure count column."""
    columns = [row[1] for row in conn.execute("PRAGMA table_info(bugs)")]
    if "consecutive_failures" not in columns:
        conn.execute("ALTER TABLE bugs ADD COLUMN consecutive_failures INTEGER DEFAULT 0")


def _migrate_v2_to_v3(conn: sqlite3.Connection) -> None:
    """Convert the legacy bugs table to knowledge while preserving all records."""
    conn.execute("""
    CREATE TABLE knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_kind TEXT NOT NULL DEFAULT 'bug', category TEXT NOT NULL,
        key_pattern TEXT NOT NULL, context TEXT DEFAULT '', cause TEXT NOT NULL,
        content TEXT NOT NULL, action_steps TEXT DEFAULT '[]', title TEXT DEFAULT '',
        language TEXT DEFAULT 'any', project_type TEXT DEFAULT 'any', tags TEXT DEFAULT '',
        confidence INTEGER DEFAULT 100 CHECK(confidence BETWEEN 0 AND 100),
        usage_count INTEGER DEFAULT 0, success_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active' CHECK(status IN ('active','deprecated','obsolete','archived')),
        replaced_by_id INTEGER REFERENCES knowledge(id) ON DELETE SET NULL,
        valid_for TEXT, deprecation_note TEXT, consecutive_failures INTEGER DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
    """)
    conn.execute("""
    INSERT INTO knowledge(
        id, entry_kind, category, key_pattern, context, cause, content, action_steps,
        title, language, project_type, tags, confidence, usage_count, success_count,
        status, replaced_by_id, valid_for, deprecation_note, consecutive_failures,
        created_at, updated_at
    )
    SELECT id, 'bug', error_type, error_pattern, error_message, root_cause, solution,
        solution_steps, '', language, project_type, tags, confidence, usage_count,
        success_count, status, replaces_id, valid_for, deprecation_note,
        consecutive_failures, created_at, updated_at
    FROM bugs
    """)
    for name in ("bugs_fts_insert", "bugs_fts_delete", "bugs_fts_update"):
        conn.execute(f"DROP TRIGGER IF EXISTS {name}")
    conn.execute("DROP TABLE IF EXISTS bugs_fts")
    conn.execute("DROP TABLE IF EXISTS bugs")
    conn.executescript("""
    CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge(status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_language ON knowledge(language);
    CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);
    CREATE INDEX IF NOT EXISTS idx_knowledge_confidence ON knowledge(confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entry_kind ON knowledge(entry_kind);
    CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        key_pattern, context, cause, content, tags,
        content=knowledge, content_rowid=id, tokenize='trigram'
    );
    INSERT INTO knowledge_fts(rowid, key_pattern, context, cause, content, tags)
        SELECT id, key_pattern, context, cause, content, tags FROM knowledge;
    CREATE TRIGGER knowledge_fts_insert AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts(rowid, key_pattern, context, cause, content, tags)
        VALUES (new.id, new.key_pattern, new.context, new.cause, new.content, new.tags);
    END;
    CREATE TRIGGER knowledge_fts_delete AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, key_pattern, context, cause, content, tags)
        VALUES ('delete', old.id, old.key_pattern, old.context, old.cause, old.content, old.tags);
    END;
    CREATE TRIGGER knowledge_fts_update AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, key_pattern, context, cause, content, tags)
        VALUES ('delete', old.id, old.key_pattern, old.context, old.cause, old.content, old.tags);
        INSERT INTO knowledge_fts(rowid, key_pattern, context, cause, content, tags)
        VALUES (new.id, new.key_pattern, new.context, new.cause, new.content, new.tags);
    END;
    """)


MIGRATIONS = {1: _migrate_v0_to_v1, 2: _migrate_v1_to_v2, 3: _migrate_v2_to_v3}


class BugDB:
    """SQLite BugDB data access layer with transactions isolated by connection."""

    def __init__(self, db_path: Path | str | None = None, *, read_only: bool = False):
        """Read-only recall skips schema migration; the default retains legacy CLI initialization behavior."""
        self._path = paths.get_db_path(db_path)
        self._read_only = read_only
        if read_only:
            with self._connection() as conn:
                if conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge'"
                ).fetchone() is None:
                    raise SchemaMigrationError(
                        "legacy schema needs explicit setup before read-only recall"
                    )
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    @property
    def path(self) -> Path:
        """Return the current database path."""
        return self._path

    @contextmanager
    def _connection(self):
        """Open a transaction connection with WAL and foreign-key enforcement."""
        conn = (sqlite3.connect(self._path.resolve().as_uri() + "?mode=ro", uri=True)
                if self._read_only else sqlite3.connect(str(self._path)))
        if self._read_only:
            conn.execute("PRAGMA query_only=ON")
        else:
            conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        """Apply schema migrations in order through the latest version."""
        with self._connection() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)")
            current = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] or 0
            target = max(MIGRATIONS)
            failed = current
            try:
                for version in range(current + 1, target + 1):
                    failed = version
                    MIGRATIONS[version](conn)
                    conn.execute("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)",
                                 (version, utils.now_iso()))
            except sqlite3.Error as error:
                raise SchemaMigrationError(f"migration to v{failed} failed: {error}") from error

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> KnowledgeRecord:
        """Convert a SQLite row to a domain record."""
        steps = utils.safe_json_loads(row["action_steps"] or "[]") or []
        return KnowledgeRecord(
            id=row["id"], entry_kind=EntryKind(row["entry_kind"]),
            category=Category(row["category"]), key_pattern=row["key_pattern"],
            context=row["context"] or "", cause=row["cause"], content=row["content"],
            action_steps=steps, title=row["title"] or "", language=row["language"] or "any",
            project_type=row["project_type"] or "any", tags=utils.comma_split(row["tags"] or ""),
            confidence=row["confidence"], usage_count=row["usage_count"],
            success_count=row["success_count"], status=Status(row["status"]),
            replaced_by_id=row["replaced_by_id"], valid_for=row["valid_for"],
            deprecation_note=row["deprecation_note"],
            consecutive_failures=row["consecutive_failures"] or 0,
            created_at=row["created_at"], updated_at=row["updated_at"],
        )

    @staticmethod
    def _value(item):
        """Extract an enum value or retain the string."""
        return item.value if isinstance(item, (EntryKind, Category, Status)) else item

    def add(self, record: KnowledgeRecord) -> KnowledgeRecord:
        """Insert a record and return a copy with ID and timestamps."""
        now = utils.now_iso()
        created = record.created_at or now
        with self._connection() as conn:
            cursor = conn.execute(
                """INSERT INTO knowledge(
                entry_kind, category, key_pattern, context, cause, content, action_steps,
                title, language, project_type, tags, confidence, usage_count, success_count,
                status, replaced_by_id, valid_for, deprecation_note, consecutive_failures,
                created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (self._value(record.entry_kind), self._value(record.category), record.key_pattern,
                 record.context, record.cause, record.content, utils.to_json_array(record.action_steps),
                 record.title, record.language, record.project_type, utils.comma_join(record.tags),
                 record.confidence, record.usage_count, record.success_count, self._value(record.status),
                 record.replaced_by_id, record.valid_for, record.deprecation_note,
                 record.consecutive_failures, created, now),
            )
        return replace(record, id=cursor.lastrowid, created_at=created, updated_at=now)

    def get(self, record_id: int) -> KnowledgeRecord:
        """Read a record by ID."""
        with self._connection() as conn:
            row = conn.execute(f"SELECT {_COLUMNS} FROM knowledge WHERE id=?", (record_id,)).fetchone()
        if row is None:
            raise RecordNotFound(f"record id={record_id} not found")
        return self._row_to_record(row)

    def list_all(self, status: str | None = None, language: str | None = None) -> list[KnowledgeRecord]:
        """List records by status or language."""
        sql = f"SELECT {_COLUMNS} FROM knowledge WHERE 1=1"
        params: list = []
        if status and status != "all":
            sql += " AND status=?"
            params.append(status)
        if language:
            sql += " AND (language=? OR language='any')"
            params.append(language)
        sql += " ORDER BY confidence DESC, id DESC"
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._row_to_record(row) for row in rows]

    @staticmethod
    def _build_match_expr(query: str, columns: list[str]) -> str:
        """Convert keywords to an FTS5 OR expression without executing user syntax."""
        terms = [term for term in query.split() if term.strip()]
        quoted = " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms)
        return " OR ".join(f"{column}:({quoted})" for column in columns)

    def _fts_query(self, columns, query, statuses, language, limit):
        """Run FTS5 search and return SQLite rows."""
        expression = self._build_match_expr(query, columns)
        projection = ", ".join(f"knowledge.{column.strip()}" for column in _COLUMNS.split(","))
        sql = (f"SELECT {projection} FROM knowledge_fts JOIN knowledge ON knowledge.id=knowledge_fts.rowid "
               "WHERE knowledge_fts MATCH ?")
        params: list = [expression]
        if statuses:
            sql += f" AND knowledge.status IN ({','.join('?' * len(statuses))})"
            params.extend(statuses)
        if language:
            sql += " AND (knowledge.language=? OR knowledge.language='any')"
            params.append(language)
        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)
        with self._connection() as conn:
            return conn.execute(sql, params).fetchall()

    def _like_fallback(self, columns, query, statuses, language, limit):
        """Use LIKE when FTS5 is unavailable."""
        terms = [term for term in query.split() if term]
        if not terms:
            return []
        where = " OR ".join(f"{column} LIKE ? ESCAPE '\\'" for column in columns for _ in terms)
        params: list = []
        for column in columns:
            for term in terms:
                escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                params.append(f"%{escaped}%")
        sql = f"SELECT {_COLUMNS} FROM knowledge WHERE ({where})"
        if statuses:
            sql += f" AND status IN ({','.join('?' * len(statuses))})"
            params.extend(statuses)
        if language:
            sql += " AND (language=? OR language='any')"
            params.append(language)
        sql += " ORDER BY confidence DESC, success_count DESC LIMIT ?"
        params.append(limit)
        with self._connection() as conn:
            return conn.execute(sql, params).fetchall()

    def fts_search(self, columns, query, statuses=None, language=None, limit=20):
        """Run FTS5 search, falling back to LIKE on failure."""
        if not query or not query.strip():
            return []
        safe = query.replace('"', " ").strip()
        if len(safe.replace(" ", "")) < 3:
            rows = self._like_fallback(columns, safe, statuses, language, limit)
        else:
            try:
                rows = self._fts_query(columns, safe, statuses, language, limit)
            except Exception:
                rows = self._like_fallback(columns, safe, statuses, language, limit)
        return [self._row_to_record(row) for row in rows]
