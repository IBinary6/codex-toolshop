"""Verify read-only recall boundaries and record policy revisions."""

import sqlite3
import gc
import io
import tempfile
import unittest
from contextlib import closing, redirect_stderr
from pathlib import Path
from unittest import mock

from bugdb.db import BugDB, _migrate_v0_to_v1
from bugdb.models import Category, KnowledgeRecord
from local_knowledge import storage
from local_knowledge.cli import build_parser
from local_knowledge.storage import KnowledgeBase


class WorkflowBoundaryTests(unittest.TestCase):
    """All databases live in test temporary directories; never access the user shared knowledge base."""

    def setUp(self) -> None:
        """Allocate an isolated database for each test."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.db = Path(temporary.name) / "knowledge.db"

    def snapshot(self) -> tuple:
        """Record data file bytes and schema to detect writes on read-only paths."""
        with closing(sqlite3.connect(self.db)) as conn:
            schema = conn.execute("SELECT name, sql FROM sqlite_master ORDER BY name").fetchall()
        return self.db.read_bytes(), schema

    def test_read_only_recall_does_not_create_missing_database(self) -> None:
        """Initial hook recall must not create a database or parent directory."""
        missing = self.db.parent / "absent" / "knowledge.db"
        with self.assertRaises(sqlite3.OperationalError):
            KnowledgeBase(missing, read_only=True)
        self.assertFalse(missing.parent.exists())

    def test_read_only_recall_does_not_repair_missing_index(self) -> None:
        """LIKE recall continues when the index is missing, leaving database content and schema unchanged."""
        base = KnowledgeBase(self.db)
        saved = base.remember("portable verified fix", kind="bug")
        with closing(sqlite3.connect(self.db)) as conn, conn:
            storage._drop_fts_triggers(conn)
            conn.execute("DROP TABLE knowledge_items_fts")
        before = self.snapshot()
        readonly = KnowledgeBase(self.db, read_only=True)
        results = readonly.recall("portable verified fix", include_legacy_bugs=False)
        self.assertEqual(results[0]["id"], saved["id"])
        self.assertEqual(readonly.stats()["schema"]["knowledge_items_fts_mode"], "like")
        self.assertEqual(self.snapshot(), before)
        with self.assertRaises(sqlite3.OperationalError):
            readonly.remember("must not write")
        self.assertEqual(self.snapshot(), before)

    def test_read_only_unavailable_tokenizer_does_not_drop_triggers(self) -> None:
        """If current Python lacks the tokenizer, fall back read-only without deleting persistent triggers."""
        base = KnowledgeBase(self.db)
        base.remember("portable tokenizer regression")
        before = self.snapshot()
        with mock.patch("local_knowledge.storage._probe_fts_table",
                        side_effect=sqlite3.OperationalError("no such tokenizer: trigram")):
            readonly = KnowledgeBase(self.db, read_only=True)
        self.assertTrue(readonly.recall("portable tokenizer regression", include_legacy_bugs=False))
        self.assertEqual(self.snapshot(), before)

    def test_read_only_legacy_v3_does_not_initialize_new_table(self) -> None:
        """An existing v3 bug database can be queried without creating general knowledge tables."""
        legacy = BugDB(self.db)
        legacy.add(KnowledgeRecord(
            category=Category.LINK, key_pattern="LNK2019 missing symbol",
            context="LNK2019 missing symbol", cause="missing linked library",
            content="link the required library",
        ))
        before = self.snapshot()
        readonly = KnowledgeBase(self.db, read_only=True)
        results = readonly.recall("LNK2019 missing symbol")
        self.assertTrue(any(item["source"] == "legacy_bug" for item in results))
        self.assertFalse(readonly.stats()["schema"]["knowledge_items"])
        self.assertEqual(self.snapshot(), before)

    def test_read_only_legacy_v1_does_not_migrate(self) -> None:
        """Report maintenance needed for a legacy bugs table without migrating during a query."""
        with closing(sqlite3.connect(self.db)) as conn:
            _migrate_v0_to_v1(conn)
        before = self.snapshot()
        readonly = KnowledgeBase(self.db, read_only=True)
        with self.assertRaisesRegex(storage.KnowledgeError, "explicit setup"):
            readonly.recall("LNK2019 missing symbol")
        self.assertEqual(self.snapshot(), before)

    def test_same_content_can_tighten_recall_policy_and_sensitivity(self) -> None:
        """Confidentiality and manual recall policy must apply even when the body is unchanged, preventing automatic injection."""
        base = KnowledgeBase(self.db)
        original = base.remember("internal workflow alias", canonical_key="workflow")
        tightened = base.remember(
            "internal workflow alias", canonical_key="workflow",
            recall_policy="manual", sensitivity="confidential",
        )
        self.assertEqual(tightened["operation"], "updated")
        self.assertEqual(tightened["id"], original["id"])
        self.assertEqual(tightened["revision"], original["revision"] + 1)
        self.assertEqual(base.recall("internal workflow alias", include_legacy_bugs=False), [])
        self.assertTrue(base.recall("internal workflow alias", explicit=True,
                                    include_legacy_bugs=False))

    def test_same_content_can_update_cues_and_restore_archived_record(self) -> None:
        """Cue revisions and restoring archived records produce real updates; repeated state is idempotent."""
        base = KnowledgeBase(self.db)
        item = base.remember("stable fact", canonical_key="fact", cues="oldcue")
        updated = base.remember("stable fact", canonical_key="fact", cues="newcue")
        self.assertEqual(updated["operation"], "updated")
        self.assertTrue(base.recall("newcue", include_legacy_bugs=False))
        base.archive(item["id"])
        restored = base.remember("stable fact", canonical_key="fact", cues="newcue")
        self.assertEqual(restored["operation"], "updated")
        self.assertEqual(restored["status"], "active")
        same = base.remember("stable fact", canonical_key="fact", cues="newcue")
        self.assertEqual(same["operation"], "unchanged")
        self.assertEqual(same["revision"], restored["revision"])

    def test_content_update_preserves_omitted_metadata(self) -> None:
        """Editing only the body cannot make a confidential record automatic or rewrite its authority."""
        base = KnowledgeBase(self.db)
        base.remember("internal alias", canonical_key="alias", title="internal",
                      cues="internal", tags="customer", recall_policy="manual",
                      authority="verified_local", sensitivity="confidential")
        updated = base.remember("internal alias revised", canonical_key="alias")
        self.assertEqual(updated["recall_policy"], "manual")
        self.assertEqual(updated["sensitivity"], "confidential")
        self.assertEqual(updated["authority"], "verified_local")
        self.assertEqual(updated["title"], "internal")
        self.assertEqual(updated["cues"], ["internal"])
        self.assertEqual(updated["tags"], ["customer"])
        cleared = base.remember("internal alias revised", canonical_key="alias",
                                title="", cues="", tags="")
        self.assertEqual(cleared["title"], "")
        self.assertEqual(cleared["cues"], [])
        self.assertEqual(cleared["tags"], [])
        self.assertEqual(cleared["recall_policy"], "manual")

    def test_read_only_flag_is_available_on_read_commands(self) -> None:
        """The CLI read-only flag explicitly applies to queries, reads, and diagnostics."""
        parser = build_parser()
        for command in (["recall"], ["stats"], ["get", "--id", "1"]):
            self.assertTrue(parser.parse_args([*command, "--read-only"]).read_only)

    def test_kind_filter_precedes_fts_and_like_candidate_limits(self) -> None:
        """Even many relevant facts cannot displace an explicitly requested bug fix."""
        cue = "error LNK2019 typed candidate needle"
        create_fts_table = storage._create_fts_table
        for mode in ("default", "unicode61", "like"):
            with self.subTest(mode=mode):
                def create_for_mode(conn, tokenizer):
                    if mode == "like":
                        raise sqlite3.OperationalError("no such module: fts5")
                    if mode == "unicode61" and tokenizer == "trigram":
                        raise sqlite3.OperationalError("no such tokenizer: trigram")
                    create_fts_table(conn, tokenizer)

                with mock.patch("local_knowledge.storage._create_fts_table",
                                side_effect=create_for_mode):
                    base = KnowledgeBase(self.db.parent / f"kind-{mode}.db")
                if mode != "default":
                    self.assertEqual(base._fts_mode, mode)
                wanted = base.remember(cue, kind="bug", canonical_key="wanted")
                for index in range(125):
                    base.remember(cue, kind="fact", canonical_key=f"noise.{index}")
                recalled = base.recall(cue, kind="bug", limit=1,
                                       include_legacy_bugs=False)
                self.assertEqual([item["id"] for item in recalled], [wanted["id"]])
                generic = base.recall(cue, limit=1, include_legacy_bugs=False)
                self.assertEqual(generic[0]["kind"], "fact")

    def test_kind_filter_keeps_legacy_bugs_only_for_bug_queries(self) -> None:
        """Default queries still include legacy fixes; queries for other kinds exclude legacy bugs."""
        cue = "LNK2019 kind filter legacy probe"
        legacy = BugDB(self.db)
        legacy.add(KnowledgeRecord(
            category=Category.LINK, key_pattern=cue, context=cue,
            cause="missing linked library", content="link the required library",
        ))
        base = KnowledgeBase(self.db)
        base.remember(cue, kind="fact", canonical_key="reference")
        self.assertEqual({item["kind"] for item in base.recall(cue)}, {"bug", "fact"})
        facts = base.recall(cue, kind="fact")
        self.assertEqual([item["source"] for item in facts], ["local_knowledge"])
        bugs = base.recall(cue, kind="bug")
        self.assertEqual([item["source"] for item in bugs], ["legacy_bug"])
        self.assertEqual(base.recall(cue, kind="bug", include_legacy_bugs=False), [])

    def test_kind_filter_rejects_invalid_values_in_api_and_cli(self) -> None:
        """An invalid kind must not silently broaden to general recall."""
        base = KnowledgeBase(self.db)
        for kind in ("unsupported", ""):
            with self.subTest(kind=kind), self.assertRaises(storage.KnowledgeArgumentError):
                base.recall("typed recall", kind=kind)
        parser = build_parser()
        self.assertEqual(parser.parse_args(["recall", "--kind", "bug"]).kind, "bug")
        self.assertIsNone(parser.parse_args(["recall"]).kind)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            parser.parse_args(["recall", "--kind", "unsupported"])
        self.assertEqual(error.exception.code, 2)

    def test_memory_database_closes_when_owner_is_released(self) -> None:
        """In-memory databases must leave no SQLite connection after examples or short queries end."""
        base = KnowledgeBase(":memory:")
        connection = base._keepalive
        del base
        gc.collect()
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")


if __name__ == "__main__":
    unittest.main()
