"""Verify safe fallback paths for different SQLite FTS5 capabilities."""

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from local_knowledge import storage
from local_knowledge.storage import KnowledgeBase


class FtsFallbackTests(unittest.TestCase):
    """Cover trigram, regular FTS5, and LIKE index capabilities."""

    def setUp(self) -> None:
        """Create an isolated database path for each case."""
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.db_path = Path(self._temporary_directory.name) / "knowledge.db"

    def test_falls_back_to_default_fts_when_trigram_is_unavailable(self) -> None:
        """Without trigram, create regular FTS5 and triggers and support Chinese prefix recall."""
        create_fts_table = storage._create_fts_table

        def without_trigram(conn: sqlite3.Connection, tokenizer: str) -> None:
            if tokenizer == "trigram":
                raise sqlite3.OperationalError("no such tokenizer: trigram")
            create_fts_table(conn, tokenizer)

        with mock.patch("local_knowledge.storage._create_fts_table",
                        side_effect=without_trigram):
            base = KnowledgeBase(self.db_path)

        created = base.remember(
            "\u6211\u504f\u597d\u6df1\u8272\u6a21\u5f0f",
            kind="preference",
            canonical_key="editor.theme",
            cues="\u6df1\u8272\u6a21\u5f0f",
        )
        recalled = base.recall("\u6df1\u8272", include_legacy_bugs=False)
        self.assertTrue(any(item["id"] == created["id"] for item in recalled))
        substring = base.remember(
            "\u56e2\u961f\u7edf\u4e00\u4f7f\u7528\u84dd\u8272\u4e3b\u9898\u914d\u7f6e",
            kind="fact",
            canonical_key="editor.team_theme",
        )
        substring_recall = base.recall("\u84dd\u8272\u4e3b\u9898", include_legacy_bugs=False)
        self.assertTrue(any(item["id"] == substring["id"] for item in substring_recall))
        schema = base.stats()["schema"]
        self.assertEqual(schema["knowledge_items_fts_mode"], "unicode61")
        self.assertTrue(schema["knowledge_items_fts"])
        self.assertTrue(schema["knowledge_items_fts_triggers"])

    def test_falls_back_to_like_when_fts5_is_unavailable(self) -> None:
        """Without FTS5, avoid broken triggers and use LIKE within the same scope."""
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
        """Disk or database errors must not be mistaken for acceptable FTS capability fallback."""
        with mock.patch(
            "local_knowledge.storage._create_fts_table",
            side_effect=sqlite3.OperationalError("database or disk is full"),
        ):
            with self.assertRaisesRegex(sqlite3.OperationalError, "disk is full"):
                KnowledgeBase(self.db_path)

    def test_reopening_existing_fts_does_not_recreate_schema(self) -> None:
        """Keep existing FTS tables and triggers unchanged during capability probing."""
        original = KnowledgeBase(self.db_path)
        before = original.stats()["schema"]
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
            before_sql = conn.execute(
                "SELECT name, type, sql FROM sqlite_master "
                "WHERE name LIKE 'knowledge_items_fts%' ORDER BY name"
            ).fetchall()

        with mock.patch("local_knowledge.storage._create_fts_table") as create:
            reopened = KnowledgeBase(self.db_path)

        create.assert_not_called()
        self.assertEqual(reopened.stats()["schema"], before)
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
            after_sql = conn.execute(
                "SELECT name, type, sql FROM sqlite_master "
                "WHERE name LIKE 'knowledge_items_fts%' ORDER BY name"
            ).fetchall()
        self.assertEqual(after_sql, before_sql)

    def test_existing_unsupported_tokenizer_disables_triggers_for_like(self) -> None:
        """If a legacy FTS tokenizer is unavailable, disable triggers and keep the base table writable."""
        original = KnowledgeBase(self.db_path)
        item = original.remember(
            "legacy tokenizer content",
            kind="fact",
            canonical_key="storage.legacy_tokenizer",
        )
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
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
        """Restoring FTS triggers must rebuild an index whose row count matches but content is stale."""
        original = KnowledgeBase(self.db_path)
        item = original.remember(
            "alpha obsolete tokens",
            kind="fact",
            canonical_key="storage.rebuild_equal_count",
        )
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
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
        """LIKE fallback must preserve exact phrases before candidate truncation."""
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
        """FTS candidate truncation must occur after scope and policy filtering."""
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
        """Default FTS must merge exact-phrase candidates to avoid premature bm25 truncation."""
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
        """Short cues that cannot form an FTS query still need LIKE prefiltering."""
        base = KnowledgeBase(self.db_path)
        target = base.remember(
            "x",
            kind="fact",
            canonical_key="storage.short.target",
        )
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
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
