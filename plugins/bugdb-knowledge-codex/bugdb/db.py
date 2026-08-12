"""BugDB SQLite 数据访问层。

数据库 schema 与 Claude BugDB v3 保持兼容，Codex 默认直接共享 Claude 数据库。
迁移其它数据源时由 CLI 在源库上只读查询，再通过本模块写入目标库。
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
    """创建 Claude BugDB v1 兼容表和 trigram FTS。"""
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
    """补充连续失败计数列。"""
    columns = [row[1] for row in conn.execute("PRAGMA table_info(bugs)")]
    if "consecutive_failures" not in columns:
        conn.execute("ALTER TABLE bugs ADD COLUMN consecutive_failures INTEGER DEFAULT 0")


def _migrate_v2_to_v3(conn: sqlite3.Connection) -> None:
    """把旧 bugs 表转换为 knowledge 表，保留所有已有记录。"""
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
    """SQLite BugDB DAL，按连接隔离事务。"""

    def __init__(self, db_path: Path | str | None = None):
        self._path = paths.get_db_path(db_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    @property
    def path(self) -> Path:
        """返回当前数据库路径。"""
        return self._path

    @contextmanager
    def _connection(self):
        """打开启用 WAL 和外键约束的事务连接。"""
        conn = sqlite3.connect(str(self._path))
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
        """依次应用 schema 迁移到最新版本。"""
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
        """将 SQLite 行转换成领域记录。"""
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
        """取出枚举值或保留字符串。"""
        return item.value if isinstance(item, (EntryKind, Category, Status)) else item

    def add(self, record: KnowledgeRecord) -> KnowledgeRecord:
        """插入记录并返回带 ID 与时间戳的副本。"""
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
        """按 ID 读取记录。"""
        with self._connection() as conn:
            row = conn.execute(f"SELECT {_COLUMNS} FROM knowledge WHERE id=?", (record_id,)).fetchone()
        if row is None:
            raise RecordNotFound(f"record id={record_id} not found")
        return self._row_to_record(row)

    def update(self, record: KnowledgeRecord) -> KnowledgeRecord:
        """整行更新记录。"""
        if record.id is None:
            raise RecordNotFound("cannot update record without id")
        record.updated_at = utils.now_iso()
        with self._connection() as conn:
            cursor = conn.execute(
                """UPDATE knowledge SET entry_kind=?, category=?, key_pattern=?, context=?, cause=?,
                content=?, action_steps=?, title=?, language=?, project_type=?, tags=?, confidence=?,
                usage_count=?, success_count=?, status=?, replaced_by_id=?, valid_for=?,
                deprecation_note=?, consecutive_failures=?, updated_at=? WHERE id=?""",
                (self._value(record.entry_kind), self._value(record.category), record.key_pattern,
                 record.context, record.cause, record.content, utils.to_json_array(record.action_steps),
                 record.title, record.language, record.project_type, utils.comma_join(record.tags),
                 record.confidence, record.usage_count, record.success_count, self._value(record.status),
                 record.replaced_by_id, record.valid_for, record.deprecation_note,
                 record.consecutive_failures, record.updated_at, record.id),
            )
            if cursor.rowcount == 0:
                raise RecordNotFound(f"record id={record.id} not found")
        return record

    def delete(self, record_id: int, hard: bool = False) -> None:
        """软删除记录，``hard=True`` 时物理删除。"""
        if hard:
            with self._connection() as conn:
                cursor = conn.execute("DELETE FROM knowledge WHERE id=?", (record_id,))
                if cursor.rowcount == 0:
                    raise RecordNotFound(f"record id={record_id} not found")
            return
        record = self.get(record_id)
        record.status = Status.ARCHIVED
        self.update(record)

    def restore(self, record_id: int) -> KnowledgeRecord:
        """将归档记录恢复为 active。"""
        record = self.get(record_id)
        record.status = Status.ACTIVE
        record.consecutive_failures = 0
        return self.update(record)

    def feedback(self, record_id: int, success: bool) -> KnowledgeRecord:
        """记录一次方案反馈，并按原规则更新置信度。"""
        record = self.get(record_id)
        record.usage_count += 1
        if success:
            record.success_count += 1
            record.consecutive_failures = 0
        else:
            record.consecutive_failures += 1
            rate = record.success_count / record.usage_count
            if (record.consecutive_failures >= _DECAY_FAILURE_THRESHOLD
                    and rate < _DECAY_SUCCESS_RATE):
                record.confidence = max(record.confidence - _DECAY_STEP, _DECAY_FLOOR)
                record.consecutive_failures = 0
                if record.confidence <= _DECAY_FLOOR:
                    record.status = Status.DEPRECATED
                    record.deprecation_note = "auto: low confidence"
        return self.update(record)

    def list_all(self, status: str | None = None, language: str | None = None) -> list[KnowledgeRecord]:
        """按状态或语言列出记录。"""
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

    def stats(self) -> dict:
        """返回记录总数及分类统计。"""
        with self._connection() as conn:
            total = conn.execute("SELECT COUNT(*) FROM knowledge").fetchone()[0]
            by_status = dict(conn.execute("SELECT status, COUNT(*) FROM knowledge GROUP BY status").fetchall())
            by_language = dict(conn.execute("SELECT language, COUNT(*) FROM knowledge GROUP BY language").fetchall())
            by_category = dict(conn.execute("SELECT category, COUNT(*) FROM knowledge GROUP BY category").fetchall())
            by_entry_kind = dict(conn.execute("SELECT entry_kind, COUNT(*) FROM knowledge GROUP BY entry_kind").fetchall())
        return {"total": total, "by_status": by_status, "by_language": by_language,
                "by_category": by_category, "by_entry_kind": by_entry_kind,
                "db_path": str(self._path)}

    @staticmethod
    def _build_match_expr(query: str, columns: list[str]) -> str:
        """把关键词转换为不执行用户语法的 FTS5 OR 表达式。"""
        terms = [term for term in query.split() if term.strip()]
        quoted = " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms)
        return " OR ".join(f"{column}:({quoted})" for column in columns)

    def _fts_query(self, columns, query, statuses, language, limit):
        """执行 FTS5 搜索并返回 SQLite 行。"""
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
        """使用 LIKE 作为 FTS5 不可用时的兜底。"""
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
        """执行 FTS5 搜索，失败时回退 LIKE。"""
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

    def like_search(self, columns, query, statuses=None, language=None, limit=20):
        """执行不依赖 FTS 分词的 LIKE 子串检索。"""
        rows = self._like_fallback(columns, query or "", statuses, language, limit)
        return [self._row_to_record(row) for row in rows]

    def list_by_filters(self, category=None, language=None, entry_kind=None,
                        tags_any=None, statuses=None, limit=20):
        """按分类、语言、类型和标签列出记录。"""
        statuses = statuses or ["active"]
        sql = f"SELECT {_COLUMNS} FROM knowledge WHERE status IN ({','.join('?' * len(statuses))})"
        params: list = list(statuses)
        if category:
            sql += " AND category=?"
            params.append(category)
        if language:
            sql += " AND (language=? OR language='any')"
            params.append(language)
        if entry_kind:
            sql += " AND entry_kind=?"
            params.append(entry_kind)
        if tags_any:
            sql += " AND (" + " OR ".join("tags LIKE ? ESCAPE '\\'" for _ in tags_any) + ")"
            for tag in tags_any:
                escaped = tag.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                params.append(f"%{escaped}%")
        sql += " ORDER BY confidence DESC, success_count DESC, id DESC LIMIT ?"
        params.append(limit)
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._row_to_record(row) for row in rows]
