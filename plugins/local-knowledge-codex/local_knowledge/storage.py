"""SQLite storage, deduplication, and local recall for Local Knowledge.

This module uses only the Python standard library and stores new knowledge in separate
``knowledge_items`` tables and a ``knowledge_items_fts`` index where supported. Legacy tables
remain under the compatibility module; this adapter reads old records only during recall.
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import weakref
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from bugdb import paths

from .errors import (KnowledgeArgumentError, KnowledgeError,
                     KnowledgeNotFound, SensitiveContentError)
from .models import KnowledgeItem

_KINDS = frozenset({"bug", "preference", "fact", "note", "decision", "workflow"})
_SCOPES = frozenset({"global", "workspace", "repository"})
_POLICIES = frozenset({"pinned", "on_match", "manual"})
_AUTHORITIES = frozenset({"user_asserted", "verified_local", "imported"})
_SENSITIVITIES = frozenset({"normal", "confidential"})
_STATUSES = frozenset({"active", "archived"})
_CJK_RE = re.compile(r"[\u3400-\u9fff]+")
_WORD_RE = re.compile(r"[a-z0-9][a-z0-9_./:+-]*", re.IGNORECASE)
_FTS_COLUMNS = ("canonical_key", "title", "content", "cues", "tags")
_FTS_TRIGGER_NAMES = (
    "knowledge_items_fts_insert",
    "knowledge_items_fts_delete",
    "knowledge_items_fts_update",
)
# Suppress weak matches sharing just one common English word; exact phrases and useful Chinese cues score much higher.
_MIN_MATCH_SCORE = 8.0
_SENSITIVE_PATTERNS = (
    re.compile(
        r"\b(?:my\s+)?(?:password|passwd|pwd|api[ _-]?key|access[ _-]?token|"
        r"auth[ _-]?token|refresh[ _-]?token|token|secret)"
        r"\s*(?::|=|\bis\b|\bequals?\b)\s*\S+",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:API\s*\u5bc6\u94a5|\u8bbf\u95ee\u4ee4\u724c|\u8ba4\u8bc1\u4ee4\u724c|\u5237\u65b0\u4ee4\u724c|\u5bc6\u7801|\u53e3\u4ee4|\u4ee4\u724c|\u5bc6\u94a5|\u79d8\u94a5)"
        r"\s*(?:(?:\u662f|\u4e3a|\u53eb)\s*[:\uff1a]?|[:\uff1a=])\s*\S+",
        re.IGNORECASE,
    ),
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", re.IGNORECASE),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE),
    re.compile(r"\b(?:sk|rk)-[A-Za-z0-9]{16,}\b", re.IGNORECASE),
    re.compile(r"\bgh[ps]_[A-Za-z0-9]{20,}\b", re.IGNORECASE),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
)


def _clean_text(value: Any) -> str:
    """Normalize user text while preserving meaningful characters and folding whitespace."""
    if value is None:
        return ""
    normalized = unicodedata.normalize("NFKC", str(value))
    return " ".join(normalized.split()).strip()


def _clean_content(value: Any) -> str:
    """Normalize body line endings and trim outer whitespace while preserving internal formatting and code blocks."""
    if value is None:
        return ""
    # Only normalize line endings and edges in the body; avoid NFKC or whitespace folding that would alter code or tables.
    normalized = str(value)
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    return normalized.strip()


def _normalize_scope_path(value: str) -> str:
    """Normalize scope paths and apply case semantics for the current platform."""
    expanded = os.path.expanduser(_clean_text(value))
    absolute = os.path.abspath(expanded)
    return os.path.normcase(os.path.normpath(absolute))


def _scope_ancestors(scope_key: str) -> tuple[str, ...]:
    """Return path ancestors including the path itself, using boundary comparisons to avoid sibling matches."""
    current = _normalize_scope_path(scope_key)
    ancestors: list[str] = []
    seen: set[str] = set()
    while current not in seen:
        ancestors.append(current)
        seen.add(current)
        parent = os.path.normcase(os.path.normpath(os.path.dirname(current)))
        if parent == current:
            break
        current = parent
    return tuple(ancestors)


def _clean_list(values: Iterable[Any] | str | None) -> tuple[str, ...]:
    """Normalize comma-separated or sequence cues and tags, removing duplicates."""
    if values is None:
        return ()
    if isinstance(values, str):
        values = values.split(",")
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = _clean_text(value)
        if item and item.casefold() not in seen:
            seen.add(item.casefold())
            result.append(item)
    return tuple(result)


def _now_iso() -> str:
    """Return a stable timezone-aware ISO timestamp."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _value(value: str, allowed: frozenset[str], field: str) -> str:
    """Validate and return a lowercase domain enum value."""
    normalized = _clean_text(value).casefold()
    if normalized not in allowed:
        values = ", ".join(sorted(allowed))
        raise KnowledgeArgumentError(f"{field} must be one of: {values}")
    return normalized


def _canonical_key(content: str, supplied: str | None) -> str:
    """Return an explicit key or a stable key derived from the body."""
    if supplied and _clean_text(supplied):
        return _clean_text(supplied).casefold()
    digest = hashlib.sha256(content.casefold().encode("utf-8")).hexdigest()
    return f"content:{digest}"


def _reject_sensitive(content: str) -> None:
    """Reject obvious credentials so local knowledge does not become a secret store."""
    # Apply NFKC only to the detection copy; save the original body to preserve full-width input and code blocks.
    normalized = unicodedata.normalize("NFKC", content)
    if any(pattern.search(normalized) for pattern in _SENSITIVE_PATTERNS):
        raise SensitiveContentError(
            "refusing to store sensitive credential material; remove the secret first"
        )


def _tokenize(text: str) -> tuple[str, ...]:
    """Extract English tokens and Chinese bigrams for local matching in both languages."""
    normalized = _clean_text(text).casefold()
    tokens = list(_WORD_RE.findall(normalized))
    for run in _CJK_RE.findall(normalized):
        tokens.extend(run[index:index + 2] for index in range(len(run) - 1))
        if len(run) == 1:
            tokens.append(run)
    return tuple(tokens)


def _fts_query(cue: str) -> str:
    """Build a safe trigram FTS OR query; leave short cues to exact scanning.

    Example:
        >>> '"\u6df1\u8272\u6a21"' in _fts_query("\u6df1\u8272\u6a21\u5f0f")
        True
    """
    normalized = _clean_text(cue).casefold()
    terms = [token for token in _WORD_RE.findall(normalized) if len(token) >= 3]
    for run in _CJK_RE.findall(normalized):
        terms.extend(run[index:index + 3] for index in range(len(run) - 2))
    unique = dict.fromkeys(terms)
    return " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in unique)


def _unicode_fts_query(cue: str) -> str:
    """Build a safe prefix query for the default unicode61 tokenizer.

    Example:
        >>> _unicode_fts_query("\u6df1\u8272\u6a21\u5f0f")
        '"\u6df1\u8272\u6a21\u5f0f"*'
    """
    normalized = _clean_text(cue).casefold()
    terms = [token for token in _WORD_RE.findall(normalized) if len(token) >= 2]
    terms.extend(run for run in _CJK_RE.findall(normalized) if len(run) >= 2)
    unique = dict.fromkeys(terms)
    return " OR ".join(
        f'"{term.replace(chr(34), chr(34) * 2)}"*' for term in unique
    )


def _create_fts_table(conn: sqlite3.Connection, tokenizer: str) -> None:
    """Create an external-content FTS5 table with an explicitly allowed tokenizer.

    Example:
        ``_create_fts_table(conn, "unicode61")`` does not require the trigram extension.
    """
    if tokenizer not in {"trigram", "unicode61"}:
        raise ValueError(f"unsupported FTS tokenizer: {tokenizer}")
    conn.execute(
        "CREATE VIRTUAL TABLE knowledge_items_fts USING fts5("
        "canonical_key, title, content, cues, tags, "
        "content='knowledge_items', content_rowid='id', "
        f"tokenize='{tokenizer}')"
    )


def _fts_trigger_names(conn: sqlite3.Connection) -> set[str]:
    """Return knowledge index synchronization triggers present in the database."""
    placeholders = ",".join("?" for _ in _FTS_TRIGGER_NAMES)
    return {
        str(row[0]) for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='trigger' "
            f"AND name IN ({placeholders})",
            _FTS_TRIGGER_NAMES,
        ).fetchall()
    }


def _ensure_fts_triggers(conn: sqlite3.Connection) -> bool:
    """Add missing FTS synchronization triggers and report whether anything was repaired."""
    repaired = not set(_FTS_TRIGGER_NAMES).issubset(_fts_trigger_names(conn))
    conn.executescript(
        """
        CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_insert
            AFTER INSERT ON knowledge_items BEGIN
            INSERT INTO knowledge_items_fts(rowid, canonical_key, title, content, cues, tags)
            VALUES (new.id, new.canonical_key, new.title, new.content, new.cues, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_delete
            AFTER DELETE ON knowledge_items BEGIN
            INSERT INTO knowledge_items_fts(knowledge_items_fts, rowid, canonical_key, title, content, cues, tags)
            VALUES ('delete', old.id, old.canonical_key, old.title, old.content, old.cues, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_update
            AFTER UPDATE ON knowledge_items BEGIN
            INSERT INTO knowledge_items_fts(knowledge_items_fts, rowid, canonical_key, title, content, cues, tags)
            VALUES ('delete', old.id, old.canonical_key, old.title, old.content, old.cues, old.tags);
            INSERT INTO knowledge_items_fts(rowid, canonical_key, title, content, cues, tags)
            VALUES (new.id, new.canonical_key, new.title, new.content, new.cues, new.tags);
        END;
        """
    )
    return repaired


def _drop_fts_triggers(conn: sqlite3.Connection) -> None:
    """Disable synchronization triggers if FTS is unavailable so the base table remains writable."""
    for name in _FTS_TRIGGER_NAMES:
        conn.execute(f"DROP TRIGGER IF EXISTS {name}")


def _is_fts_capability_error(error: sqlite3.Error) -> bool:
    """Check whether an error only means FTS5 or the specified tokenizer is unavailable."""
    message = str(error).casefold()
    return any(fragment in message for fragment in (
        "no such module: fts5",
        "no such tokenizer",
        "unknown tokenizer",
    ))


def _fts_tokenizer(sql: str) -> str | None:
    """Recognize only the trigram or unicode61 tokenizer declarations supported by this plugin."""
    match = re.search(
        r"\btokenize\s*=\s*(['\"])(trigram|unicode61)(?:\s[^'\"]*)?\1",
        sql,
        re.IGNORECASE,
    )
    return match.group(2).casefold() if match else None


def _probe_fts_table(conn: sqlite3.Connection) -> None:
    """Verify an existing FTS table and tokenizer with a real MATCH query."""
    conn.execute(
        "SELECT rowid FROM knowledge_items_fts "
        "WHERE knowledge_items_fts MATCH ? LIMIT 1",
        ('"__codex_fts_probe__"',),
    ).fetchone()


def _ensure_fts_schema(conn: sqlite3.Connection) -> tuple[str, bool]:
    """Preserve existing FTS or choose a fallback and report whether the index needs rebuilding."""
    existing = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' "
        "AND name='knowledge_items_fts'"
    ).fetchone()
    if existing is not None:
        sql = str(existing["sql"] if isinstance(existing, sqlite3.Row) else existing[0])
        mode = _fts_tokenizer(sql)
        if mode is None:
            _drop_fts_triggers(conn)
            return "like", False
        try:
            _probe_fts_table(conn)
        except sqlite3.Error as error:
            if not _is_fts_capability_error(error):
                raise
            _drop_fts_triggers(conn)
            return "like", False
        repaired = _ensure_fts_triggers(conn)
        return mode, repaired

    for tokenizer in ("trigram", "unicode61"):
        try:
            _create_fts_table(conn, tokenizer)
        except sqlite3.Error as error:
            if not _is_fts_capability_error(error):
                raise
            continue
        repaired = _ensure_fts_triggers(conn)
        return tokenizer, repaired
    return "like", False


def _like_pattern(term: str) -> str:
    """Escape SQLite LIKE metacharacters and return a substring-match argument."""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


class KnowledgeBase:
    """Manage general local knowledge independently and recall safely by occasion.

    Example:
        >>> base = KnowledgeBase(":memory:")
        >>> base.remember("\u6211\u504f\u597d\u6df1\u8272\u6a21\u5f0f", kind="preference")["operation"]
        'created'
    """

    def __init__(self, db_path: Path | str | None = None, *, read_only: bool = False):
        """Resolve the shared path; read-only mode checks existing tables without initialization or migration."""
        self._path = paths.get_db_path(db_path)
        self._read_only = read_only
        self._memory = str(self._path) == ":memory:"
        self._keepalive: sqlite3.Connection | None = None
        self._fts_mode = "like"
        self._has_knowledge_table = True
        if self._read_only:
            self._inspect_schema()
            return
        if not self._memory:
            self._path.parent.mkdir(parents=True, exist_ok=True)
        else:
            self._keepalive = sqlite3.connect(":memory:")
            self._keepalive.row_factory = sqlite3.Row
            # The in-memory database lives with KnowledgeBase; close its sole keeper connection when the object is released.
            weakref.finalize(self, self._keepalive.close)
        self._ensure_schema()

    @property
    def path(self) -> Path:
        """Return the SQLite path actually used."""
        return self._path

    @contextmanager
    def _connection(self):
        """Open a transaction connection, committing success and rolling back on errors."""
        if self._keepalive is not None:
            try:
                yield self._keepalive
                self._keepalive.commit()
            except Exception:
                self._keepalive.rollback()
                raise
            return
        conn = (sqlite3.connect(self._path.resolve().as_uri() + "?mode=ro", uri=True)
                if self._read_only else sqlite3.connect(str(self._path)))
        conn.row_factory = sqlite3.Row
        if self._read_only:
            conn.execute("PRAGMA query_only=ON")
        else:
            conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=3000")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _inspect_schema(self) -> None:
        """Inspect base tables and existing indexes read-only; do not repair persistent objects if a capability is missing."""
        with self._connection() as conn:
            self._has_knowledge_table = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_items'"
            ).fetchone() is not None
            row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_items_fts'"
            ).fetchone()
            mode = _fts_tokenizer(row["sql"]) if row is not None else None
            if mode:
                try:
                    _probe_fts_table(conn)
                except sqlite3.Error as error:
                    if not _is_fts_capability_error(error):
                        raise
                else:
                    self._fts_mode = mode

    def _ensure_schema(self) -> None:
        """Create neutral knowledge tables and choose a safe index mode based on SQLite capabilities."""
        with self._connection() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS knowledge_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL CHECK(kind IN ('bug','preference','fact','note','decision','workflow')),
                    canonical_key TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL,
                    cues TEXT NOT NULL DEFAULT '',
                    tags TEXT NOT NULL DEFAULT '',
                    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','workspace','repository')),
                    scope_key TEXT NOT NULL DEFAULT '',
                    recall_policy TEXT NOT NULL CHECK(recall_policy IN ('pinned','on_match','manual')),
                    authority TEXT NOT NULL CHECK(authority IN ('user_asserted','verified_local','imported')),
                    sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal','confidential')),
                    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(scope_kind, scope_key, kind, canonical_key)
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_items_status
                    ON knowledge_items(status);
                CREATE INDEX IF NOT EXISTS idx_knowledge_items_scope
                    ON knowledge_items(scope_kind, scope_key);
                CREATE INDEX IF NOT EXISTS idx_knowledge_items_policy
                    ON knowledge_items(recall_policy, status);
                """
            )
            self._fts_mode, rebuild_required = _ensure_fts_schema(conn)
            if self._fts_mode != "like":
                item_count = conn.execute("SELECT COUNT(*) FROM knowledge_items").fetchone()[0]
                fts_count = conn.execute("SELECT COUNT(*) FROM knowledge_items_fts").fetchone()[0]
                if rebuild_required or item_count != fts_count:
                    conn.execute(
                        "INSERT INTO knowledge_items_fts(knowledge_items_fts) VALUES ('rebuild')"
                    )

    def _row_to_item(self, row: sqlite3.Row) -> KnowledgeItem:
        """Convert a SQLite row to an immutable domain record."""
        return KnowledgeItem(
            id=int(row["id"]),
            kind=row["kind"],
            canonical_key=row["canonical_key"],
            title=row["title"] or "",
            content=row["content"],
            cues=tuple(_clean_list(row["cues"])),
            tags=tuple(_clean_list(row["tags"])),
            scope_kind=row["scope_kind"],
            scope_key=row["scope_key"] or "",
            recall_policy=row["recall_policy"],
            authority=row["authority"],
            sensitivity=row["sensitivity"],
            status=row["status"],
            revision=int(row["revision"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _find_existing(self, conn: sqlite3.Connection, scope_kind: str,
                       scope_key: str, kind: str, canonical_key: str):
        """Find an existing record by deduplication dimensions."""
        return conn.execute(
            """SELECT * FROM knowledge_items
               WHERE scope_kind=? AND scope_key=? AND kind=? AND canonical_key=?""",
            (scope_kind, scope_key, kind, canonical_key),
        ).fetchone()

    def remember(self, content: str, *, kind: str = "note",
                 canonical_key: str | None = None, title: str | None = None,
                 cues: Iterable[Any] | str | None = None,
                 tags: Iterable[Any] | str | None = None,
                 scope_kind: str = "global", scope_key: str = "",
                 recall_policy: str | None = None,
                 authority: str | None = None, sensitivity: str | None = None) -> dict[str, Any]:
        """Explicitly save knowledge with idempotent deduplication by scope, kind, and key.

        Example:
            >>> KnowledgeBase(":memory:").remember("Use clang", kind="fact")["revision"]
            1
        """
        normalized_content = _clean_content(content)
        if not normalized_content:
            raise KnowledgeArgumentError("content must not be empty")
        kind = _value(kind, _KINDS, "kind")
        scope_kind = _value(scope_kind, _SCOPES, "scope_kind")
        raw_scope_key = _clean_text(scope_key) if scope_kind != "global" else ""
        if scope_kind != "global" and not raw_scope_key:
            raise KnowledgeArgumentError("scope_key must not be empty for scoped knowledge")
        scope_key = _normalize_scope_path(raw_scope_key) if scope_kind != "global" else ""
        key = _canonical_key(normalized_content, canonical_key)
        now = _now_iso()
        with self._connection() as conn:
            existing = self._find_existing(conn, scope_kind, scope_key, kind, key)

            def retained(value: Any, field: str, default: str) -> Any:
                """Preserve old fields when omitted so a text revision does not loosen recall or confidentiality policy."""
                if value is not None:
                    return value
                return existing[field] if existing is not None else default

            title = _clean_text(retained(title, "title", ""))
            cue_values = _clean_list(retained(cues, "cues", ""))
            tag_values = _clean_list(retained(tags, "tags", ""))
            recall_policy = _value(retained(recall_policy, "recall_policy", "on_match"),
                                   _POLICIES, "recall_policy")
            authority = _value(retained(authority, "authority", "user_asserted"),
                               _AUTHORITIES, "authority")
            sensitivity = _value(retained(sensitivity, "sensitivity", "normal"),
                                 _SENSITIVITIES, "sensitivity")
            if sensitivity == "confidential" and recall_policy != "manual":
                raise KnowledgeArgumentError(
                    "confidential knowledge must use recall_policy=manual"
                )
            if authority == "imported" and recall_policy == "pinned":
                raise KnowledgeArgumentError(
                    "imported knowledge cannot use recall_policy=pinned"
                )
            _reject_sensitive(" ".join((normalized_content, title, key,
                                        *cue_values, *tag_values)))
            desired = {
                "title": title, "content": normalized_content,
                "cues": ",".join(cue_values), "tags": ",".join(tag_values),
                "recall_policy": recall_policy, "authority": authority,
                "sensitivity": sensitivity, "status": "active",
            }
            if existing is not None and all(existing[field] == value
                                            for field, value in desired.items()):
                item = self._row_to_item(existing)
                return self._receipt(item, "unchanged")
            if existing is None:
                cursor = conn.execute(
                    """INSERT INTO knowledge_items(
                    kind, canonical_key, title, content, cues, tags, scope_kind, scope_key,
                    recall_policy, authority, sensitivity, status, revision, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)""",
                    (kind, key, title, normalized_content, ",".join(cue_values), ",".join(tag_values),
                     scope_kind, scope_key, recall_policy, authority, sensitivity, now, now),
                )
                item = self._row_to_item(conn.execute(
                    "SELECT * FROM knowledge_items WHERE id=?", (cursor.lastrowid,)
                ).fetchone())
                return self._receipt(item, "created")
            revision = int(existing["revision"]) + 1
            conn.execute(
                """UPDATE knowledge_items SET title=?, content=?, cues=?, tags=?, recall_policy=?,
                   authority=?, sensitivity=?, status='active', revision=?, updated_at=? WHERE id=?""",
                (title, normalized_content, ",".join(cue_values), ",".join(tag_values),
                 recall_policy, authority, sensitivity, revision, now, existing["id"]),
            )
            item = self._row_to_item(conn.execute(
                "SELECT * FROM knowledge_items WHERE id=?", (existing["id"],)
            ).fetchone())
            return self._receipt(item, "updated")

    def _receipt(self, item: KnowledgeItem, operation: str) -> dict[str, Any]:
        """Generate a stable JSON receipt for remember."""
        receipt = item.to_dict()
        receipt["operation"] = operation
        receipt["db_path"] = str(self._path)
        return receipt

    def get(self, item_id: int) -> dict[str, Any]:
        """Read a new knowledge record."""
        try:
            item_id = int(item_id)
        except (TypeError, ValueError) as error:
            raise KnowledgeArgumentError("id must be an integer") from error
        with self._connection() as conn:
            row = conn.execute("SELECT * FROM knowledge_items WHERE id=?", (item_id,)).fetchone()
        if row is None:
            raise KnowledgeNotFound(f"knowledge item id={item_id} not found")
        return self._row_to_item(row).to_dict()

    def _set_status(self, item_id: int, status: str) -> dict[str, Any]:
        """Change record status and increment revision."""
        status = _value(status, _STATUSES, "status")
        try:
            item_id = int(item_id)
        except (TypeError, ValueError) as error:
            raise KnowledgeArgumentError("id must be an integer") from error
        with self._connection() as conn:
            row = conn.execute("SELECT * FROM knowledge_items WHERE id=?", (item_id,)).fetchone()
            if row is None:
                raise KnowledgeNotFound(f"knowledge item id={item_id} not found")
            conn.execute(
                "UPDATE knowledge_items SET status=?, revision=?, updated_at=? WHERE id=?",
                (status, int(row["revision"]) + 1, _now_iso(), item_id),
            )
            updated = conn.execute("SELECT * FROM knowledge_items WHERE id=?", (item_id,)).fetchone()
        return self._row_to_item(updated).to_dict()

    def archive(self, item_id: int) -> dict[str, Any]:
        """Archive a record so it no longer appears in automatic recall."""
        return self._set_status(item_id, "archived")

    def restore(self, item_id: int) -> dict[str, Any]:
        """Restore a record so it participates in recall again."""
        return self._set_status(item_id, "active")

    @staticmethod
    def _scope_sql(scope_kind: str | None, scope_key: str | None) -> tuple[str, list[str]]:
        """Build scope filters with ancestor inheritance while excluding sibling paths.

        Example:
            ``workspace=/repo/src`` allows ``/repo`` and ``/repo/src``,
            but not ``/repo/tests``.
        """
        if not scope_kind:
            return " AND scope_kind='global'", []
        scope_kind = _value(scope_kind, _SCOPES, "scope_kind")
        if scope_kind == "global":
            return " AND scope_kind='global'", []
        key = _clean_text(scope_key)
        if not key:
            raise KnowledgeArgumentError("scope_key must not be empty for scoped recall")
        ancestors = _scope_ancestors(key)
        candidate_kinds = ("repository",) if scope_kind == "repository" else (
            "repository", "workspace"
        )
        clauses = ["scope_kind='global'"]
        params: list[str] = []
        for candidate_kind in candidate_kinds:
            for ancestor in ancestors:
                clauses.append("(scope_kind=? AND scope_key=?)")
                params.extend((candidate_kind, ancestor))
        return " AND (" + " OR ".join(clauses) + ")", params

    @staticmethod
    def _allowed_policies(policy: str | None, occasion: str | None,
                          explicit: bool, cue: str) -> tuple[str, ...]:
        """Compute allowed recall_policy values by occasion to prevent accidental manual injection."""
        if policy:
            policy = _value(policy, _POLICIES, "recall_policy")
        if explicit:
            return (policy,) if policy else tuple(sorted(_POLICIES))
        if policy == "manual":
            return ()
        if occasion and occasion.casefold().replace("-", "_") == "session_start":
            return ("pinned",) if not policy or policy == "pinned" else ()
        if policy:
            return (policy,)
        # With a cue, a pinned preference may also appear in an exactly relevant query; this lets the same
        # preference be injected at session start and returned for a specific question.
        return ("on_match", "pinned") if cue else ()

    @staticmethod
    def _score_text(cue: str, text: str) -> tuple[float, str] | None:
        """Score candidate bodies by phrases, English tokens, and Chinese fragments."""
        query = _clean_text(cue).casefold()
        if not query:
            return 100.0, "empty cue allowed by policy"
        corpus = _clean_text(text).casefold()
        score = 0.0
        reasons: list[str] = []
        if query in corpus:
            score += 100.0
            reasons.append("exact phrase")
        query_words = set(_WORD_RE.findall(query))
        corpus_words = set(_WORD_RE.findall(corpus))
        word_hits = query_words & corpus_words
        if word_hits:
            score += 30.0 * len(word_hits) / max(1, len(query_words))
            reasons.append("English token overlap")
        query_cjk = set(token for token in _tokenize(query) if _CJK_RE.fullmatch(token or ""))
        corpus_cjk = set(token for token in _tokenize(corpus) if _CJK_RE.fullmatch(token or ""))
        cjk_hits = query_cjk & corpus_cjk
        if cjk_hits:
            score += 40.0 * len(cjk_hits) / max(1, len(query_cjk))
            reasons.append("Chinese fragment overlap")
        if score <= 0:
            return None
        return score, ", ".join(reasons)

    @staticmethod
    def _row_candidate(row: sqlite3.Row, cue: str) -> dict[str, Any] | None:
        """Score candidates from the new table and convert them to recall results."""
        item = KnowledgeItem(
            id=int(row["id"]), kind=row["kind"], canonical_key=row["canonical_key"],
            title=row["title"] or "", content=row["content"], cues=tuple(_clean_list(row["cues"])),
            tags=tuple(_clean_list(row["tags"])), scope_kind=row["scope_kind"],
            scope_key=row["scope_key"] or "", recall_policy=row["recall_policy"],
            authority=row["authority"], sensitivity=row["sensitivity"], status=row["status"],
            revision=int(row["revision"]), created_at=row["created_at"], updated_at=row["updated_at"],
        )
        weighted = " ".join((item.title, item.content, *item.cues, *item.tags, item.canonical_key))
        score = KnowledgeBase._score_text(cue, weighted)
        if score is None or score[0] < _MIN_MATCH_SCORE:
            return None
        result = item.to_dict()
        result["score"], result["match_reason"] = score
        return result

    def _candidate_rows(self, conn: sqlite3.Connection, cue: str,
                        policies: tuple[str, ...], scope_sql: str,
                        scope_params: list[str], explicit: bool,
                        limit: int, kind: str | None = None) -> list[sqlite3.Row]:
        """Prefer FTS for candidates; scan within scope only for short cues or index failures.

        Example:
            ``_candidate_rows`` never returns inactive or out-of-scope records.
        """
        placeholders = ",".join("?" for _ in policies)
        sensitivity_sql = "" if explicit else " AND sensitivity='normal'"
        where = ("status='active' "
                 f"AND recall_policy IN ({placeholders}){sensitivity_sql}{scope_sql}")
        params: list[Any] = [*policies, *scope_params]
        if kind is not None:
            where += " AND kind=?"
            params.append(kind)
        candidate_limit = max(limit * 20, 100)
        query = (_fts_query(cue) if self._fts_mode == "trigram"
                 else _unicode_fts_query(cue))
        fts_rows: list[sqlite3.Row] = []
        if self._fts_mode != "like" and query:
            try:
                fts_rows = conn.execute(
                    "SELECT knowledge_items.* FROM knowledge_items_fts "
                    "JOIN knowledge_items "
                    "ON knowledge_items.id=knowledge_items_fts.rowid "
                    "WHERE knowledge_items_fts MATCH ? AND " + where
                    + " ORDER BY bm25(knowledge_items_fts), "
                    "knowledge_items.updated_at DESC LIMIT ?",
                    [query, *params, candidate_limit],
                ).fetchall()
            except sqlite3.Error as error:
                if not _is_fts_capability_error(error):
                    raise
                # Disable triggers if the capability fails at runtime; LIKE still enforces the original policy and scope limits.
                if not self._read_only:
                    _drop_fts_triggers(conn)
                self._fts_mode = "like"
        if cue:
            normalized_cue = _clean_text(cue).casefold()
            if self._fts_mode == "trigram" and query:
                # Trigram covers normal terms; add back full phrases that bm25 might have truncated.
                terms = [normalized_cue]
            else:
                terms = list(dict.fromkeys((normalized_cue, *_tokenize(cue))))
            terms = [term for term in terms if term][:32]
            if terms:
                clauses = [
                    f"{column} LIKE ? ESCAPE '\\'"
                    for column in _FTS_COLUMNS for _ in terms
                ]
                like_params = [
                    _like_pattern(term) for _ in _FTS_COLUMNS for term in terms
                ]
                exact_pattern = _like_pattern(normalized_cue)
                exact_parts = [
                    f"{column} LIKE ? ESCAPE '\\'" for column in _FTS_COLUMNS
                ]
                exact_params = [exact_pattern] * len(_FTS_COLUMNS)
                rank_parts: list[str] = []
                rank_params: list[str] = []
                for term in terms:
                    for column in _FTS_COLUMNS:
                        rank_parts.append(
                            f"CASE WHEN {column} LIKE ? ESCAPE '\\' "
                            "THEN 1 ELSE 0 END"
                        )
                        rank_params.append(_like_pattern(term))
                like_rows = conn.execute(
                    "SELECT * FROM knowledge_items WHERE (" + " OR ".join(clauses)
                    + ") AND " + where + " ORDER BY CASE WHEN ("
                    + " OR ".join(exact_parts) + ") THEN 1 ELSE 0 END DESC, ("
                    + " + ".join(rank_parts)
                    + ") DESC, updated_at DESC LIMIT ?",
                    [*like_params, *params, *exact_params, *rank_params, candidate_limit],
                ).fetchall()
                seen = {int(row["id"]) for row in fts_rows}
                return [
                    *fts_rows,
                    *(row for row in like_rows if int(row["id"]) not in seen),
                ]
        return conn.execute(
            "SELECT * FROM knowledge_items WHERE " + where
            + " ORDER BY updated_at DESC LIMIT ?",
            [*params, candidate_limit],
        ).fetchall()

    def _legacy_results(self, cue: str, limit: int) -> list[dict[str, Any]]:
        """Read actual FTS/LIKE hits from legacy bug tables without nearby-category fallback."""
        if not cue.strip():
            return []
        with self._connection() as conn:
            legacy_table = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' "
                "AND name IN ('knowledge','bugs') LIMIT 1"
            ).fetchone()
        if legacy_table is None:
            return []
        try:
            from bugdb.db import BugDB
            from bugdb.exceptions import BugDBError
            from bugdb.search import search

            records = search(BugDB(self._path, read_only=self._read_only), cue,
                             include_deprecated=False, limit=limit)
        except (BugDBError, sqlite3.Error) as error:
            raise KnowledgeError(f"legacy knowledge lookup failed: {error}") from error
        results: list[dict[str, Any]] = []
        for record in records:
            text = " ".join((record.key_pattern, record.context, record.cause,
                             record.content, " ".join(record.tags)))
            score = self._score_text(cue, text)
            if score is None:
                # Legacy FTS may match normalized tokens; retain those real hits without expanding to nearby categories.
                score = (1.0, "legacy FTS match")
            results.append({
                "id": record.id,
                "source": "legacy_bug",
                "kind": "bug",
                "canonical_key": record.key_pattern,
                "title": record.title,
                "content": record.content,
                "cause": record.cause,
                "action_steps": list(record.action_steps),
                "tags": list(record.tags),
                "category": record.category.value,
                "status": record.status.value,
                "updated_at": record.updated_at,
                "score": score[0],
                "match_reason": score[1],
            })
        return results

    @staticmethod
    def _fit_budget(results: list[dict[str, Any]], max_chars: int | None) -> list[dict[str, Any]]:
        """Truncate results to a content character budget so automatic hints stay bounded."""
        if max_chars is None:
            return results
        try:
            budget = int(max_chars)
        except (TypeError, ValueError) as error:
            raise KnowledgeArgumentError("max_chars must be an integer") from error
        if budget <= 0:
            raise KnowledgeArgumentError("max_chars must be greater than zero")
        selected: list[dict[str, Any]] = []
        remaining = budget
        for original in results:
            result = dict(original)
            title = str(result.get("title") or "")
            content = str(result.get("content") or "")
            cost = len(title) + len(content)
            if cost <= remaining:
                selected.append(result)
                remaining -= cost
                continue
            available = max(0, remaining - len(title))
            if available:
                result["content"] = content[:available]
                result["truncated"] = len(result["content"]) < len(content)
                selected.append(result)
            break
        return selected

    def recall(self, cue: str = "", *, scope_kind: str | None = None,
               scope_key: str | None = None, policy: str | None = None,
               occasion: str | None = None, explicit: bool = False,
               include_legacy_bugs: bool = True, limit: int = 5,
               max_chars: int | None = 4000,
               kind: str | None = None) -> list[dict[str, Any]]:
        """Recall knowledge by occasion, scope, and local lexical relevance.

        Example:
            >>> base = KnowledgeBase(":memory:")
            >>> _ = base.remember("dark mode", kind="preference", recall_policy="pinned")
            >>> len(base.recall("dark mode", occasion="prompt", include_legacy_bugs=False))
            1
        """
        cue = _clean_text(cue)
        if kind is not None:
            kind = _value(kind, _KINDS, "kind")
        try:
            limit = int(limit)
        except (TypeError, ValueError) as error:
            raise KnowledgeArgumentError("limit must be an integer") from error
        if limit <= 0:
            raise KnowledgeArgumentError("limit must be greater than zero")
        policies = self._allowed_policies(policy, occasion, explicit, cue)
        results: list[dict[str, Any]] = []
        if policies and self._has_knowledge_table:
            scope_sql, scope_params = self._scope_sql(scope_kind, scope_key)
            with self._connection() as conn:
                rows = self._candidate_rows(conn, cue, policies, scope_sql,
                                            scope_params, explicit, limit, kind)
            for row in rows:
                result = self._row_candidate(row, cue)
                if result is not None:
                    results.append(result)
        if include_legacy_bugs and cue and kind in (None, "bug"):
            results.extend(self._legacy_results(cue, max(limit * 2, limit)))
        results.sort(key=lambda item: (-float(item.get("score", 0)), -int(item.get("id", 0))))
        return self._fit_budget(results[:limit], max_chars)

    def stats(self) -> dict[str, Any]:
        """Return new-table statistics and explicitly report FTS table and synchronization trigger presence."""
        with self._connection() as conn:
            total, by_kind, by_status = 0, {}, {}
            if self._has_knowledge_table:
                total = conn.execute("SELECT COUNT(*) FROM knowledge_items").fetchone()[0]
                by_kind = dict(conn.execute(
                    "SELECT kind, COUNT(*) FROM knowledge_items GROUP BY kind"
                ).fetchall())
                by_status = dict(conn.execute(
                    "SELECT status, COUNT(*) FROM knowledge_items GROUP BY status"
                ).fetchall())
            legacy_bug_total = 0
            legacy_table = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name IN ('knowledge','bugs') ORDER BY name='knowledge' DESC LIMIT 1"
            ).fetchone()
            if legacy_table is not None:
                table = legacy_table["name"]
                if table == "knowledge":
                    legacy_bug_total = conn.execute(
                        "SELECT COUNT(*) FROM knowledge WHERE entry_kind='bug'"
                    ).fetchone()[0]
                else:
                    legacy_bug_total = conn.execute("SELECT COUNT(*) FROM bugs").fetchone()[0]
            names = {
                row["name"]: row["type"] for row in conn.execute(
                    "SELECT name, type FROM sqlite_master WHERE name IN "
                    "('knowledge_items','knowledge_items_fts','knowledge_items_fts_insert',"
                    "'knowledge_items_fts_delete','knowledge_items_fts_update')"
                ).fetchall()
            }
        return {
            "total": total,
            "by_kind": by_kind,
            "by_status": by_status,
            "legacy_bug_total": legacy_bug_total,
            "db_path": str(self._path),
            "schema": {
                "knowledge_items": names.get("knowledge_items") == "table",
                "knowledge_items_fts": names.get("knowledge_items_fts") == "table",
                "knowledge_items_fts_mode": self._fts_mode,
                "knowledge_items_fts_triggers": all(
                    names.get(name) == "trigger" for name in _FTS_TRIGGER_NAMES
                ),
            },
        }
