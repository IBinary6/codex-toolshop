"""Local Knowledge 的 SQLite 存储、去重和本地召回实现。

该模块只依赖 Python 标准库，并把新知识放在独立的
``knowledge_items`` 表及能力允许时的 ``knowledge_items_fts`` 索引中。旧格式表
仍由兼容模块负责读写；适配器只在召回时读取旧记录。
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
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
# 抑制只重合一个常见英文词的弱命中；精确短语和中文有效线索远高于此值。
_MIN_MATCH_SCORE = 8.0
_SENSITIVE_PATTERNS = (
    re.compile(
        r"\b(?:my\s+)?(?:password|passwd|pwd|api[ _-]?key|access[ _-]?token|"
        r"auth[ _-]?token|refresh[ _-]?token|token|secret)"
        r"\s*(?::|=|\bis\b|\bequals?\b)\s*\S+",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:API\s*密钥|访问令牌|认证令牌|刷新令牌|密码|口令|令牌|密钥|秘钥)"
        r"\s*(?:(?:是|为|叫)\s*[:：]?|[:：=])\s*\S+",
        re.IGNORECASE,
    ),
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", re.IGNORECASE),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE),
    re.compile(r"\b(?:sk|rk)-[A-Za-z0-9]{16,}\b", re.IGNORECASE),
    re.compile(r"\bgh[ps]_[A-Za-z0-9]{20,}\b", re.IGNORECASE),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
)


def _clean_text(value: Any) -> str:
    """规范化用户文本，保留语义字符并折叠空白。"""
    if value is None:
        return ""
    normalized = unicodedata.normalize("NFKC", str(value))
    return " ".join(normalized.split()).strip()


def _clean_content(value: Any) -> str:
    """规范化正文换行并去除首尾空白，保留内部格式和代码块。"""
    if value is None:
        return ""
    # 正文只做行尾和首尾处理；不做 NFKC/空白折叠，避免改写代码与表格。
    normalized = str(value)
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    return normalized.strip()


def _normalize_scope_path(value: str) -> str:
    """按当前平台规范化作用域路径并应用平台大小写语义。"""
    expanded = os.path.expanduser(_clean_text(value))
    absolute = os.path.abspath(expanded)
    return os.path.normcase(os.path.normpath(absolute))


def _scope_ancestors(scope_key: str) -> tuple[str, ...]:
    """返回包含自身的路径祖先，使用边界比较避免 sibling 误命中。"""
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
    """规范化逗号分隔或序列形式的 cue/tag，并去除重复项。"""
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
    """返回带时区的稳定 ISO 时间戳。"""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _value(value: str, allowed: frozenset[str], field: str) -> str:
    """校验并返回小写领域枚举值。"""
    normalized = _clean_text(value).casefold()
    if normalized not in allowed:
        values = ", ".join(sorted(allowed))
        raise KnowledgeArgumentError(f"{field} must be one of: {values}")
    return normalized


def _canonical_key(content: str, supplied: str | None) -> str:
    """返回显式 key 或由正文生成的稳定 key。"""
    if supplied and _clean_text(supplied):
        return _clean_text(supplied).casefold()
    digest = hashlib.sha256(content.casefold().encode("utf-8")).hexdigest()
    return f"content:{digest}"


def _reject_sensitive(content: str) -> None:
    """拒绝明显凭据，避免本地知识库变成秘密存储。"""
    # 仅检测副本做 NFKC，正文仍按原样保存，兼顾全角输入和代码块保真。
    normalized = unicodedata.normalize("NFKC", content)
    if any(pattern.search(normalized) for pattern in _SENSITIVE_PATTERNS):
        raise SensitiveContentError(
            "refusing to store sensitive credential material; remove the secret first"
        )


def _tokenize(text: str) -> tuple[str, ...]:
    """提取英文 token 与中文二元片段，兼顾两种语言的本地匹配。"""
    normalized = _clean_text(text).casefold()
    tokens = list(_WORD_RE.findall(normalized))
    for run in _CJK_RE.findall(normalized):
        tokens.extend(run[index:index + 2] for index in range(len(run) - 1))
        if len(run) == 1:
            tokens.append(run)
    return tuple(tokens)


def _fts_query(cue: str) -> str:
    """生成安全的 trigram FTS OR 查询，短线索留给精确扫描。

    Example:
        >>> '"深色模"' in _fts_query("深色模式")
        True
    """
    normalized = _clean_text(cue).casefold()
    terms = [token for token in _WORD_RE.findall(normalized) if len(token) >= 3]
    for run in _CJK_RE.findall(normalized):
        terms.extend(run[index:index + 3] for index in range(len(run) - 2))
    unique = dict.fromkeys(terms)
    return " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in unique)


def _unicode_fts_query(cue: str) -> str:
    """生成适用于默认 unicode61 tokenizer 的安全前缀查询。

    Example:
        >>> _unicode_fts_query("深色模式")
        '"深色模式"*'
    """
    normalized = _clean_text(cue).casefold()
    terms = [token for token in _WORD_RE.findall(normalized) if len(token) >= 2]
    terms.extend(run for run in _CJK_RE.findall(normalized) if len(run) >= 2)
    unique = dict.fromkeys(terms)
    return " OR ".join(
        f'"{term.replace(chr(34), chr(34) * 2)}"*' for term in unique
    )


def _create_fts_table(conn: sqlite3.Connection, tokenizer: str) -> None:
    """使用明确允许的 tokenizer 创建外部内容 FTS5 表。

    Example:
        ``_create_fts_table(conn, "unicode61")`` 不依赖 trigram 扩展。
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
    """返回当前数据库中已存在的知识索引同步触发器。"""
    placeholders = ",".join("?" for _ in _FTS_TRIGGER_NAMES)
    return {
        str(row[0]) for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='trigger' "
            f"AND name IN ({placeholders})",
            _FTS_TRIGGER_NAMES,
        ).fetchall()
    }


def _ensure_fts_triggers(conn: sqlite3.Connection) -> bool:
    """补齐 FTS 同步触发器，并报告是否修复过缺失对象。"""
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
    """在 FTS 能力不可用时停用同步触发器，保证基础表仍可写。"""
    for name in _FTS_TRIGGER_NAMES:
        conn.execute(f"DROP TRIGGER IF EXISTS {name}")


def _is_fts_capability_error(error: sqlite3.Error) -> bool:
    """判断错误是否只表示 FTS5 模块或指定 tokenizer 不可用。"""
    message = str(error).casefold()
    return any(fragment in message for fragment in (
        "no such module: fts5",
        "no such tokenizer",
        "unknown tokenizer",
    ))


def _fts_tokenizer(sql: str) -> str | None:
    """只识别插件支持的 trigram 或 unicode61 tokenizer 声明。"""
    match = re.search(
        r"\btokenize\s*=\s*(['\"])(trigram|unicode61)(?:\s[^'\"]*)?\1",
        sql,
        re.IGNORECASE,
    )
    return match.group(2).casefold() if match else None


def _probe_fts_table(conn: sqlite3.Connection) -> None:
    """用真实 MATCH 查询验证现有 FTS 表及 tokenizer 可执行。"""
    conn.execute(
        "SELECT rowid FROM knowledge_items_fts "
        "WHERE knowledge_items_fts MATCH ? LIMIT 1",
        ('"__codex_fts_probe__"',),
    ).fetchone()


def _ensure_fts_schema(conn: sqlite3.Connection) -> tuple[str, bool]:
    """保留已有 FTS，或选择降级路径，并报告是否必须重建索引。"""
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
    """转义 SQLite LIKE 元字符并返回子串匹配参数。"""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


class KnowledgeBase:
    """独立管理通用本地知识并按场景安全召回。

    Example:
        >>> base = KnowledgeBase(":memory:")
        >>> base.remember("我偏好深色模式", kind="preference")["operation"]
        'created'
    """

    def __init__(self, db_path: Path | str | None = None):
        """解析共享数据库路径并确保新表、FTS 和触发器存在。"""
        self._path = paths.get_db_path(db_path)
        self._memory = str(self._path) == ":memory:"
        self._keepalive: sqlite3.Connection | None = None
        self._fts_mode = "like"
        if not self._memory:
            self._path.parent.mkdir(parents=True, exist_ok=True)
        else:
            self._keepalive = sqlite3.connect(":memory:")
            self._keepalive.row_factory = sqlite3.Row
        self._ensure_schema()

    @property
    def path(self) -> Path:
        """返回实际使用的 SQLite 路径。"""
        return self._path

    @contextmanager
    def _connection(self):
        """打开事务连接，提交成功操作并在异常时回滚。"""
        if self._keepalive is not None:
            try:
                yield self._keepalive
                self._keepalive.commit()
            except Exception:
                self._keepalive.rollback()
                raise
            return
        conn = sqlite3.connect(str(self._path))
        conn.row_factory = sqlite3.Row
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

    def _ensure_schema(self) -> None:
        """创建中性知识表，并按 SQLite 能力选择安全的索引模式。"""
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
        """将 SQLite 行转换为不可变的领域记录。"""
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
        """按去重维度查找现有记录。"""
        return conn.execute(
            """SELECT * FROM knowledge_items
               WHERE scope_kind=? AND scope_key=? AND kind=? AND canonical_key=?""",
            (scope_kind, scope_key, kind, canonical_key),
        ).fetchone()

    def remember(self, content: str, *, kind: str = "note",
                 canonical_key: str | None = None, title: str = "",
                 cues: Iterable[Any] | str | None = None,
                 tags: Iterable[Any] | str | None = None,
                 scope_kind: str = "global", scope_key: str = "",
                 recall_policy: str = "on_match",
                 authority: str = "user_asserted", sensitivity: str = "normal") -> dict[str, Any]:
        """显式保存知识，按范围、类型和 key 幂等去重。

        Example:
            >>> KnowledgeBase(":memory:").remember("Use clang", kind="fact")["revision"]
            1
        """
        normalized_content = _clean_content(content)
        if not normalized_content:
            raise KnowledgeArgumentError("content must not be empty")
        kind = _value(kind, _KINDS, "kind")
        scope_kind = _value(scope_kind, _SCOPES, "scope_kind")
        recall_policy = _value(recall_policy, _POLICIES, "recall_policy")
        authority = _value(authority, _AUTHORITIES, "authority")
        sensitivity = _value(sensitivity, _SENSITIVITIES, "sensitivity")
        title = _clean_text(title)
        raw_scope_key = _clean_text(scope_key) if scope_kind != "global" else ""
        if scope_kind != "global" and not raw_scope_key:
            raise KnowledgeArgumentError("scope_key must not be empty for scoped knowledge")
        scope_key = _normalize_scope_path(raw_scope_key) if scope_kind != "global" else ""
        key = _canonical_key(normalized_content, canonical_key)
        cue_values = _clean_list(cues)
        tag_values = _clean_list(tags)
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
        now = _now_iso()
        with self._connection() as conn:
            existing = self._find_existing(conn, scope_kind, scope_key, kind, key)
            if existing is not None and existing["content"] == normalized_content:
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
        """生成 remember 的稳定 JSON 回执。"""
        receipt = item.to_dict()
        receipt["operation"] = operation
        receipt["db_path"] = str(self._path)
        return receipt

    def get(self, item_id: int) -> dict[str, Any]:
        """读取一条新知识记录。"""
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
        """切换记录状态并增加修订号。"""
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
        """归档一条记录，使其不再自动召回。"""
        return self._set_status(item_id, "archived")

    def restore(self, item_id: int) -> dict[str, Any]:
        """恢复一条记录，使其重新参与召回。"""
        return self._set_status(item_id, "active")

    @staticmethod
    def _scope_sql(scope_kind: str | None, scope_key: str | None) -> tuple[str, list[str]]:
        """构造范围过滤条件，按目录祖先继承并排除 sibling。

        Example:
            ``workspace=/repo/src`` 会授权 ``/repo`` 和 ``/repo/src``，
            但不会授权 ``/repo/tests``。
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
        """按召回场景计算允许的 recall_policy，防止 manual 意外注入。"""
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
        # 有线索时，pinned 偏好也允许被精确相关查询召回；这样同一条
        # 用户偏好既能在会话开始注入，也能在具体问题中按需出现。
        return ("on_match", "pinned") if cue else ()

    @staticmethod
    def _score_text(cue: str, text: str) -> tuple[float, str] | None:
        """对候选正文做短语、英文 token 和中文片段的本地打分。"""
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
            reasons.append("中文片段重合")
        if score <= 0:
            return None
        return score, ", ".join(reasons)

    @staticmethod
    def _row_candidate(row: sqlite3.Row, cue: str) -> dict[str, Any] | None:
        """把新表候选评分并转换成召回结果。"""
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
                        limit: int) -> list[sqlite3.Row]:
        """优先用 FTS 索引选候选；只有短线索或索引异常才做范围内扫描。

        Example:
            ``_candidate_rows`` 不会返回非 active 或越过 scope 的记录。
        """
        placeholders = ",".join("?" for _ in policies)
        sensitivity_sql = "" if explicit else " AND sensitivity='normal'"
        where = ("status='active' "
                 f"AND recall_policy IN ({placeholders}){sensitivity_sql}{scope_sql}")
        params: list[Any] = [*policies, *scope_params]
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
                # 运行期间能力失效时停用触发器；LIKE 仍保留原 policy/scope 限制。
                _drop_fts_triggers(conn)
                self._fts_mode = "like"
        if cue:
            normalized_cue = _clean_text(cue).casefold()
            if self._fts_mode == "trigram" and query:
                # trigram 已覆盖普通词项；这里只补回可能被 bm25 截断的完整短语。
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
        """读取旧 bug 表的真实 FTS/LIKE 命中，不调用邻区兜底。"""
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

            records = search(BugDB(self._path), cue, include_deprecated=False, limit=limit)
        except (BugDBError, sqlite3.Error) as error:
            raise KnowledgeError(f"legacy knowledge lookup failed: {error}") from error
        results: list[dict[str, Any]] = []
        for record in records:
            text = " ".join((record.key_pattern, record.context, record.cause,
                             record.content, " ".join(record.tags)))
            score = self._score_text(cue, text)
            if score is None:
                # 旧 FTS 可能按规范化 token 命中，至少保留其真实命中但不做邻区扩展。
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
                "score": score[0],
                "match_reason": score[1],
            })
        return results

    @staticmethod
    def _fit_budget(results: list[dict[str, Any]], max_chars: int | None) -> list[dict[str, Any]]:
        """按内容字符预算截断结果，避免自动提示无限增长。"""
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
               max_chars: int | None = 4000) -> list[dict[str, Any]]:
        """按场景、范围和本地词法相关性召回知识。

        Example:
            >>> base = KnowledgeBase(":memory:")
            >>> _ = base.remember("dark mode", kind="preference", recall_policy="pinned")
            >>> len(base.recall("dark mode", occasion="prompt", include_legacy_bugs=False))
            1
        """
        cue = _clean_text(cue)
        try:
            limit = int(limit)
        except (TypeError, ValueError) as error:
            raise KnowledgeArgumentError("limit must be an integer") from error
        if limit <= 0:
            raise KnowledgeArgumentError("limit must be greater than zero")
        policies = self._allowed_policies(policy, occasion, explicit, cue)
        results: list[dict[str, Any]] = []
        if policies:
            scope_sql, scope_params = self._scope_sql(scope_kind, scope_key)
            with self._connection() as conn:
                rows = self._candidate_rows(conn, cue, policies, scope_sql,
                                            scope_params, explicit, limit)
            for row in rows:
                result = self._row_candidate(row, cue)
                if result is not None:
                    results.append(result)
        if include_legacy_bugs and cue:
            results.extend(self._legacy_results(cue, max(limit * 2, limit)))
        results.sort(key=lambda item: (-float(item.get("score", 0)), -int(item.get("id", 0))))
        return self._fit_budget(results[:limit], max_chars)

    def stats(self) -> dict[str, Any]:
        """返回新表统计，并显式报告 FTS 表和同步触发器是否存在。"""
        with self._connection() as conn:
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
