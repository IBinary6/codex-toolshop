"""验证知识召回的只读边界和记录策略的可修订性。"""

import sqlite3
import gc
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from bugdb.db import BugDB, _migrate_v0_to_v1
from bugdb.models import Category, KnowledgeRecord
from local_knowledge import storage
from local_knowledge.cli import build_parser
from local_knowledge.storage import KnowledgeBase


class WorkflowBoundaryTests(unittest.TestCase):
    """所有数据库都位于测试临时目录，不访问用户的共享知识库。"""

    def setUp(self) -> None:
        """为每个测试分配独立数据库。"""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.db = Path(temporary.name) / "knowledge.db"

    def snapshot(self) -> tuple:
        """记录数据文件字节和 schema，用于检测只读路径中的写入。"""
        with closing(sqlite3.connect(self.db)) as conn:
            schema = conn.execute("SELECT name, sql FROM sqlite_master ORDER BY name").fetchall()
        return self.db.read_bytes(), schema

    def test_read_only_recall_does_not_create_missing_database(self) -> None:
        """首次 hook 召回不能创建数据库或父目录。"""
        missing = self.db.parent / "absent" / "knowledge.db"
        with self.assertRaises(sqlite3.OperationalError):
            KnowledgeBase(missing, read_only=True)
        self.assertFalse(missing.parent.exists())

    def test_read_only_recall_does_not_repair_missing_index(self) -> None:
        """索引缺失时 LIKE 继续召回，数据库内容与 schema 原样保留。"""
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
        """当前 Python 缺少 tokenizer 时只读降级，不删除持久触发器。"""
        base = KnowledgeBase(self.db)
        base.remember("portable tokenizer regression")
        before = self.snapshot()
        with mock.patch("local_knowledge.storage._probe_fts_table",
                        side_effect=sqlite3.OperationalError("no such tokenizer: trigram")):
            readonly = KnowledgeBase(self.db, read_only=True)
        self.assertTrue(readonly.recall("portable tokenizer regression", include_legacy_bugs=False))
        self.assertEqual(self.snapshot(), before)

    def test_read_only_legacy_v3_does_not_initialize_new_table(self) -> None:
        """已有 v3 错误库可直接查询，无需创建通用知识表。"""
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
        """旧 bugs 表只报告需要维护，不在查询过程中执行迁移。"""
        with closing(sqlite3.connect(self.db)) as conn:
            _migrate_v0_to_v1(conn)
        before = self.snapshot()
        readonly = KnowledgeBase(self.db, read_only=True)
        with self.assertRaisesRegex(storage.KnowledgeError, "explicit setup"):
            readonly.recall("LNK2019 missing symbol")
        self.assertEqual(self.snapshot(), before)

    def test_same_content_can_tighten_recall_policy_and_sensitivity(self) -> None:
        """正文未变时也必须生效保密和手工召回策略，不能仍然自动注入。"""
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
        """修订检索线索和恢复归档项都产生真实更新；相同状态保持幂等。"""
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
        """只改正文不能把原有保密记录降为自动注入，也不重写来源。"""
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
        """CLI 的只读标记显式用于查询、读取和诊断。"""
        parser = build_parser()
        for command in (["recall"], ["stats"], ["get", "--id", "1"]):
            self.assertTrue(parser.parse_args([*command, "--read-only"]).read_only)

    def test_memory_database_closes_when_owner_is_released(self) -> None:
        """内存库不能在示例或短期查询结束后遗留 SQLite 连接。"""
        base = KnowledgeBase(":memory:")
        connection = base._keepalive
        del base
        gc.collect()
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")


if __name__ == "__main__":
    unittest.main()
