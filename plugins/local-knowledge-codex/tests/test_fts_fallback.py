"""验证不同 SQLite FTS5 能力下的安全降级路径。"""

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from local_knowledge import storage
from local_knowledge.storage import KnowledgeBase


class FtsFallbackTests(unittest.TestCase):
    """覆盖 trigram、普通 FTS5 与 LIKE 三种索引能力。"""

    def setUp(self) -> None:
        """为每个用例创建隔离的数据库路径。"""
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.db_path = Path(self._temporary_directory.name) / "knowledge.db"

    def test_falls_back_to_default_fts_when_trigram_is_unavailable(self) -> None:
        """trigram 缺失时仍创建普通 FTS5、触发器并支持中文前缀召回。"""
        create_fts_table = storage._create_fts_table

        def without_trigram(conn: sqlite3.Connection, tokenizer: str) -> None:
            if tokenizer == "trigram":
                raise sqlite3.OperationalError("no such tokenizer: trigram")
            create_fts_table(conn, tokenizer)

        with mock.patch("local_knowledge.storage._create_fts_table",
                        side_effect=without_trigram):
            base = KnowledgeBase(self.db_path)

        created = base.remember(
            "我偏好深色模式",
            kind="preference",
            canonical_key="editor.theme",
            cues="深色模式",
        )
        recalled = base.recall("深色", include_legacy_bugs=False)
        self.assertTrue(any(item["id"] == created["id"] for item in recalled))
        substring = base.remember(
            "团队统一使用蓝色主题配置",
            kind="fact",
            canonical_key="editor.team_theme",
        )
        substring_recall = base.recall("蓝色主题", include_legacy_bugs=False)
        self.assertTrue(any(item["id"] == substring["id"] for item in substring_recall))
        schema = base.stats()["schema"]
        self.assertEqual(schema["knowledge_items_fts_mode"], "unicode61")
        self.assertTrue(schema["knowledge_items_fts"])
        self.assertTrue(schema["knowledge_items_fts_triggers"])

    def test_falls_back_to_like_when_fts5_is_unavailable(self) -> None:
        """FTS5 整体缺失时不创建坏触发器，并在同一 scope 内使用 LIKE。"""
        with mock.patch(
            "local_knowledge.storage._create_fts_table",
            side_effect=sqlite3.OperationalError("no such module: fts5"),
        ):
            base = KnowledgeBase(self.db_path)

        created = base.remember(
            "Portable fallback keeps local recall available",
            kind="fact",
            canonical_key="storage.portable_fallback",
            cues="portable fallback",
        )
        recalled = base.recall("portable fallback", include_legacy_bugs=False)
        self.assertTrue(any(item["id"] == created["id"] for item in recalled))
        repo_a = Path(self._temporary_directory.name) / "repo-a"
        repo_b = Path(self._temporary_directory.name) / "repo-b"
        scoped = base.remember(
            "LIKE fallback must preserve workspace scope",
            kind="fact",
            canonical_key="storage.like_scope",
            cues="workspace scope",
            scope_kind="workspace",
            scope_key=str(repo_a),
        )
        wrong_scope = base.recall(
            "workspace scope",
            scope_kind="workspace",
            scope_key=str(repo_b),
            include_legacy_bugs=False,
        )
        self.assertFalse(any(item["id"] == scoped["id"] for item in wrong_scope))
        right_scope = base.recall(
            "workspace scope",
            scope_kind="workspace",
            scope_key=str(repo_a),
            include_legacy_bugs=False,
        )
        self.assertTrue(any(item["id"] == scoped["id"] for item in right_scope))
        schema = base.stats()["schema"]
        self.assertEqual(schema["knowledge_items_fts_mode"], "like")
        self.assertFalse(schema["knowledge_items_fts"])
        self.assertFalse(schema["knowledge_items_fts_triggers"])

    def test_does_not_hide_unrelated_schema_errors(self) -> None:
        """磁盘或数据库错误不能被误报为可接受的 FTS 能力降级。"""
        with mock.patch(
            "local_knowledge.storage._create_fts_table",
            side_effect=sqlite3.OperationalError("database or disk is full"),
        ):
            with self.assertRaisesRegex(sqlite3.OperationalError, "disk is full"):
                KnowledgeBase(self.db_path)

    def test_reopening_existing_fts_does_not_recreate_schema(self) -> None:
        """已有 FTS 表和触发器必须原样保留，不受能力探测重建影响。"""
        original = KnowledgeBase(self.db_path)
        before = original.stats()["schema"]
        with sqlite3.connect(self.db_path) as conn:
            before_sql = conn.execute(
                "SELECT name, type, sql FROM sqlite_master "
                "WHERE name LIKE 'knowledge_items_fts%' ORDER BY name"
            ).fetchall()

        with mock.patch("local_knowledge.storage._create_fts_table") as create:
            reopened = KnowledgeBase(self.db_path)

        create.assert_not_called()
        self.assertEqual(reopened.stats()["schema"], before)
        with sqlite3.connect(self.db_path) as conn:
            after_sql = conn.execute(
                "SELECT name, type, sql FROM sqlite_master "
                "WHERE name LIKE 'knowledge_items_fts%' ORDER BY name"
            ).fetchall()
        self.assertEqual(after_sql, before_sql)

    def test_existing_unsupported_tokenizer_disables_triggers_for_like(self) -> None:
        """旧 FTS tokenizer 不可用时应停用触发器，并保持基础表可写。"""
        original = KnowledgeBase(self.db_path)
        item = original.remember(
            "legacy tokenizer content",
            kind="fact",
            canonical_key="storage.legacy_tokenizer",
        )
        with sqlite3.connect(self.db_path) as conn:
            sql = conn.execute(
                "SELECT sql FROM sqlite_master WHERE name='knowledge_items_fts'"
            ).fetchone()[0]
            altered = sql.replace("tokenize='trigram'", "tokenize='missing_tokenizer'")
            self.assertNotEqual(altered, sql)
            schema_version = conn.execute("PRAGMA schema_version").fetchone()[0]
            conn.execute("PRAGMA writable_schema=ON")
            conn.execute(
                "UPDATE sqlite_master SET sql=? WHERE name='knowledge_items_fts'",
                (altered,),
            )
            conn.execute("PRAGMA writable_schema=OFF")
            conn.execute(f"PRAGMA schema_version={schema_version + 1}")

        degraded = KnowledgeBase(self.db_path)
        self.assertEqual(degraded.stats()["schema"]["knowledge_items_fts_mode"], "like")
        self.assertFalse(degraded.stats()["schema"]["knowledge_items_fts_triggers"])
        created = degraded.remember(
            "created while FTS is unavailable",
            kind="fact",
            canonical_key="storage.like_create",
        )
        updated = degraded.remember(
            "updated while FTS is unavailable",
            kind="fact",
            canonical_key="storage.like_create",
        )
        archived = degraded.archive(item["id"])
        self.assertEqual(created["operation"], "created")
        self.assertEqual(updated["operation"], "updated")
        self.assertEqual(archived["status"], "archived")

    def test_missing_triggers_force_rebuild_even_when_row_count_matches(self) -> None:
        """恢复 FTS 触发器时必须重建等行数但内容已陈旧的索引。"""
        original = KnowledgeBase(self.db_path)
        item = original.remember(
            "alpha obsolete tokens",
            kind="fact",
            canonical_key="storage.rebuild_equal_count",
        )
        with sqlite3.connect(self.db_path) as conn:
            for trigger in storage._FTS_TRIGGER_NAMES:
                conn.execute(f"DROP TRIGGER {trigger}")
            conn.execute(
                "UPDATE knowledge_items SET content=? WHERE id=?",
                ("omega fresh needle", item["id"]),
            )

        reopened = KnowledgeBase(self.db_path)
        recalled = reopened.recall("omega fresh needle", include_legacy_bugs=False)
        self.assertTrue(any(row["id"] == item["id"] for row in recalled))
        self.assertTrue(reopened.stats()["schema"]["knowledge_items_fts_triggers"])

    def test_like_candidates_rank_exact_phrase_before_common_fillers(self) -> None:
        """LIKE 降级必须在候选截断前优先保留精确短语。"""
        with mock.patch(
            "local_knowledge.storage._create_fts_table",
            side_effect=sqlite3.OperationalError("no such module: fts5"),
        ):
            base = KnowledgeBase(self.db_path)

        terms = [f"term{index:02d}" for index in range(31)]
        query = " ".join(terms)
        reversed_query = " ".join(reversed(terms))
        for index in range(101):
            base.remember(
                reversed_query,
                kind="fact",
                canonical_key=f"{reversed_query} filler {index}",
                title=reversed_query,
                cues=[reversed_query],
                tags=[reversed_query],
            )
        target = base.remember(
            query,
            kind="fact",
            canonical_key="storage.exact_target",
        )
        recalled = base.recall(query, include_legacy_bugs=False)
        self.assertTrue(any(row["id"] == target["id"] for row in recalled))

    def test_fts_applies_scope_before_candidate_limit(self) -> None:
        """FTS 候选截断必须发生在 scope 与 policy 过滤之后。"""
        base = KnowledgeBase(self.db_path)
        self.assertNotEqual(base.stats()["schema"]["knowledge_items_fts_mode"], "like")
        repo_a = Path(self._temporary_directory.name) / "repo-a"
        repo_z = Path(self._temporary_directory.name) / "repo-z"
        query = "scoped exact needle"
        for index in range(150):
            base.remember(
                " ".join([query] * 8),
                kind="fact",
                canonical_key=f"storage.wrong_scope.{index}",
                title=query,
                cues=[query],
                tags=[query],
                scope_kind="repository",
                scope_key=str(repo_z),
            )
        target = base.remember(
            query,
            kind="fact",
            canonical_key="storage.right_scope",
            scope_kind="repository",
            scope_key=str(repo_a),
        )

        recalled = base.recall(
            query,
            scope_kind="repository",
            scope_key=str(repo_a),
            include_legacy_bugs=False,
        )

        self.assertTrue(any(row["id"] == target["id"] for row in recalled))

    def test_fts_candidates_merge_exact_phrase_before_limit(self) -> None:
        """默认 FTS 也必须合并精确短语候选，避免 bm25 提前截断。"""
        base = KnowledgeBase(self.db_path)
        self.assertNotEqual(base.stats()["schema"]["knowledge_items_fts_mode"], "like")
        query = "alpha beta gamma"
        reversed_query = "gamma beta alpha"
        for index in range(150):
            base.remember(
                reversed_query,
                kind="fact",
                canonical_key=f"{reversed_query} fts filler {index}",
                title=reversed_query,
                cues=[reversed_query],
                tags=[reversed_query],
            )
        target = base.remember(
            query,
            kind="fact",
            canonical_key="storage.fts_exact_target",
        )

        recalled = base.recall(query, include_legacy_bugs=False)

        self.assertTrue(any(row["id"] == target["id"] for row in recalled))

    def test_short_cue_uses_like_before_candidate_limit(self) -> None:
        """无法生成 FTS 查询的短线索也必须先做 LIKE 预过滤。"""
        base = KnowledgeBase(self.db_path)
        target = base.remember(
            "x",
            kind="fact",
            canonical_key="storage.short.target",
        )
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE knowledge_items SET updated_at=? WHERE id=?",
                ("2000-01-01T00:00:00+00:00", target["id"]),
            )
        for index in range(101):
            base.remember(
                f"unrelated filler {index}",
                kind="fact",
                canonical_key=f"storage.short.filler.{index}",
            )

        recalled = base.recall("x", include_legacy_bugs=False)

        self.assertTrue(any(row["id"] == target["id"] for row in recalled))


if __name__ == "__main__":
    unittest.main()
