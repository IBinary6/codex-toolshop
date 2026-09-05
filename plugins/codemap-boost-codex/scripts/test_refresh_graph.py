"""使用真实 CRG、临时 Git 仓库与 SQLite 验证刷新闭环。"""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from code_review_graph.tools._common import _get_store
from code_review_graph.tools.build import build_or_update_graph

SPEC = importlib.util.spec_from_file_location("refresh_graph", Path(__file__).with_name("refresh_graph.py"))
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)


class RefreshTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="codemap-real-refresh-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.git("init", "--quiet")
        self.git("config", "user.name", "CodeMap Test")
        self.git("config", "user.email", "test@example.invalid")
        self.source = self.root / "sample.js"
        self.source.write_text("function original() { return 1; }\n", encoding="utf-8")
        (self.root / "empty.js").write_text("", encoding="utf-8")
        (self.root / "empty.cc").write_text("", encoding="utf-8")
        (self.root / "empty.py").write_text("", encoding="utf-8")
        (self.root / "settings.yaml").write_text("enabled: true\n", encoding="utf-8")
        (self.root / ".gitignore").write_text(".code-review-graph/\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "initial")
        result = ADAPTER.refresh(self.root, full=True)
        self.assertFalse(result.get("errors"))

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.root, check=True, capture_output=True, text=True,
            timeout=30,
        ).stdout.strip()

    def metadata(self, key):
        store, _ = _get_store(str(self.root))
        try:
            return store.get_metadata(key)
        finally:
            store.close()

    def test_commit_after_indexing_advances_without_reparse(self):
        self.source.write_text("function changed() { return 2; }\n", encoding="utf-8")
        ADAPTER.refresh(self.root)
        parsed_at = self.metadata("last_updated")
        self.git("add", "sample.js")
        self.git("commit", "--quiet", "-m", "source already indexed")
        # 先重现上游 no-op：状态成功但提交编号仍旧。
        upstream = build_or_update_graph(repo_root=str(self.root))
        self.assertEqual(upstream["files_updated"], 0)
        self.assertNotEqual(self.metadata("git_head_sha"), self.git("rev-parse", "HEAD"))
        with patch("code_review_graph.tools.build.build_or_update_graph", wraps=build_or_update_graph) as build:
            result = ADAPTER.refresh(self.root)
        self.assertEqual(build.call_count, 1)
        self.assertFalse(build.call_args.kwargs["full_rebuild"])
        self.assertEqual(result["files_updated"], 0)
        self.assertTrue(result["codemap_metadata_advanced"])
        self.assertEqual(self.metadata("git_head_sha"), self.git("rev-parse", "HEAD"))
        self.assertEqual(self.metadata("last_updated"), parsed_at)

    def test_empty_commit_and_repeat_do_not_rebuild(self):
        self.git("commit", "--allow-empty", "--quiet", "-m", "metadata only")
        with patch("code_review_graph.tools.build.build_or_update_graph", wraps=build_or_update_graph) as build:
            first = ADAPTER.refresh(self.root)
            second = ADAPTER.refresh(self.root)
        self.assertEqual(build.call_count, 2)
        self.assertTrue(all(not call.kwargs["full_rebuild"] for call in build.call_args_list))
        self.assertTrue(first["codemap_metadata_advanced"])
        self.assertFalse(second["codemap_metadata_advanced"])

    def test_reverted_worktree_content_is_repaired(self):
        original = self.source.read_bytes()
        self.source.write_text("function temporary() { return 3; }\n", encoding="utf-8")
        ADAPTER.refresh(self.root)
        self.source.write_bytes(original)
        with patch("code_review_graph.tools.build.build_or_update_graph", wraps=build_or_update_graph) as build:
            ADAPTER.refresh(self.root)
        self.assertEqual([call.kwargs["full_rebuild"] for call in build.call_args_list], [False, True])
        store, _ = _get_store(str(self.root))
        try:
            names = {node.name for node in store.get_nodes_by_file(str(self.source))}
            self.assertIn("original", names)
            self.assertNotIn("temporary", names)
        finally:
            store.close()

    def test_failed_parse_never_advances_metadata(self):
        self.git("commit", "--allow-empty", "--quiet", "-m", "must remain unverified")
        failure = {"status": "ok", "files_updated": 0, "errors": [{"file": "sample.js", "error": "parser failed"}]}
        with patch("code_review_graph.tools.build.build_or_update_graph", return_value=failure):
            with self.assertRaisesRegex(RuntimeError, "未完整通过"):
                ADAPTER.refresh(self.root)
        self.assertEqual(self.metadata("git_head_sha"), "")
        self.assertIsNone(self.metadata(ADAPTER.VERIFIED_KEY))

    def test_concurrent_edit_is_not_marked_verified(self):
        self.git("commit", "--allow-empty", "--quiet", "-m", "concurrent edit")

        def change_during_build(**kwargs):
            result = build_or_update_graph(**kwargs)
            self.source.write_text("function concurrent() {}\n", encoding="utf-8")
            return result

        with patch("code_review_graph.tools.build.build_or_update_graph", side_effect=change_during_build):
            with self.assertRaisesRegex(RuntimeError, "发生变化"):
                ADAPTER.refresh(self.root)
        self.assertEqual(self.metadata("git_head_sha"), "")
        self.assertIsNone(self.metadata(ADAPTER.VERIFIED_KEY))

    def test_partial_failure_and_postprocess_warning_invalidate_upstream_sha(self):
        for issue in ("errors", "warnings"):
            with self.subTest(issue=issue):
                def write_then_fail(**kwargs):
                    result = build_or_update_graph(**kwargs)
                    result[issue] = ["injected partial failure"]
                    return result

                self.source.write_text(f"function {issue}() {{ return 2; }}\n", encoding="utf-8")
                with patch("code_review_graph.tools.build.build_or_update_graph", side_effect=write_then_fail):
                    with self.assertRaisesRegex(RuntimeError, "未完整通过"):
                        ADAPTER.refresh(self.root)
                self.assertEqual(self.metadata("git_head_sha"), "")
                self.assertIsNone(self.metadata(ADAPTER.VERIFIED_KEY))
                self.assertEqual(ADAPTER.refresh(self.root)["build_type"], "full")

    def test_old_graph_is_migrated_once(self):
        store, _ = _get_store(str(self.root))
        try:
            store._conn.execute("DELETE FROM metadata WHERE key = ?", (ADAPTER.VERIFIED_KEY,))
            store.commit()
        finally:
            store.close()
        with patch("code_review_graph.tools.build.build_or_update_graph", wraps=build_or_update_graph) as build:
            ADAPTER.refresh(self.root)
            ADAPTER.refresh(self.root)
        self.assertEqual([call.kwargs["full_rebuild"] for call in build.call_args_list], [True, False])

    def test_same_sha_branch_and_document_commit(self):
        self.git("switch", "-c", "same-sha")
        result = ADAPTER.refresh(self.root)
        self.assertEqual(result["files_updated"], 0)
        self.assertEqual(self.metadata("git_branch"), "same-sha")
        (self.root / "README.md").write_text("documentation only\n", encoding="utf-8")
        self.git("add", "README.md")
        self.git("commit", "--quiet", "-m", "documentation")
        with patch("code_review_graph.tools.build.build_or_update_graph", wraps=build_or_update_graph) as build:
            result = ADAPTER.refresh(self.root)
        self.assertEqual(build.call_count, 1)
        self.assertFalse(build.call_args.kwargs["full_rebuild"])
        self.assertEqual(result["files_updated"], 0)
        self.assertEqual(self.metadata("git_head_sha"), self.git("rev-parse", "HEAD"))

    def test_verification_holds_sqlite_write_lock(self):
        import sqlite3
        from code_review_graph.incremental import get_db_path

        original = ADAPTER.graph_matches

        def try_other_writer(root, store, files):
            other = sqlite3.connect(get_db_path(root), timeout=0)
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    other.execute("BEGIN IMMEDIATE")
            finally:
                other.close()
            return original(root, store, files)

        with patch.object(ADAPTER, "graph_matches", side_effect=try_other_writer):
            ADAPTER.refresh(self.root)

    def test_worktree_subdirectory_uses_its_own_graph_and_index(self):
        with tempfile.TemporaryDirectory(prefix="codemap-linked-") as target:
            linked = Path(target).resolve() / "worktree"
            self.git("worktree", "add", "-b", "linked-test", str(linked))
            self.assertTrue((linked / ".git").is_file())
            nested = linked / "nested" / "child"
            nested.mkdir(parents=True)
            main_proof = self.metadata(ADAPTER.VERIFIED_KEY)
            index_before = subprocess.check_output(
                ["git", "ls-files", "--stage", "-z"], cwd=linked,
            )
            ADAPTER.refresh(nested)
            self.assertTrue((linked / ".code-review-graph" / "graph.db").is_file())
            self.assertFalse((nested / ".code-review-graph").exists())
            self.assertEqual(self.metadata(ADAPTER.VERIFIED_KEY), main_proof)
            self.assertEqual(subprocess.check_output(
                ["git", "ls-files", "--stage", "-z"], cwd=linked,
            ), index_before)
            store, _ = _get_store(str(linked))
            try:
                self.assertTrue(all(Path(file).is_relative_to(linked) for file in store.get_all_files()))
                self.assertEqual(store.get_metadata("git_branch"), "linked-test")
            finally:
                store.close()

    def test_non_git_directory_does_not_create_graph(self):
        with tempfile.TemporaryDirectory(prefix="codemap-no-git-") as target:
            outside = Path(target).resolve()
            (outside / "source.js").write_text("function outside() {}\n", encoding="utf-8")
            with patch("code_review_graph.tools.build.build_or_update_graph", wraps=build_or_update_graph) as build:
                with self.assertRaisesRegex(RuntimeError, "Git"):
                    ADAPTER.refresh(outside)
            build.assert_not_called()
            self.assertFalse((outside / ".code-review-graph").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
