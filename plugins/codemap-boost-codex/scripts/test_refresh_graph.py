"""使用真实 CRG、临时 Git 仓库与 SQLite 验证刷新闭环。"""

import importlib.util
from pathlib import Path
import subprocess
import sys
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
        # 固定上游 no-op 合约：不同 CRG 版本可能重解析已提交文件，
        # 此处明确验证零更新响应下适配器仍会推进元数据且不改解析时间。
        upstream = {"status": "ok", "files_updated": 0}
        self.assertNotEqual(self.metadata("git_head_sha"), self.git("rev-parse", "HEAD"))
        with patch("code_review_graph.tools.build.build_or_update_graph", return_value=upstream) as build:
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

    def test_runtime_identity_change_rebuilds_a_verified_graph(self):
        """运行时包身份变化不能复用旧 runtime 写入的可信 proof。"""
        store, _ = _get_store(str(self.root))
        try:
            self.assertTrue(ADAPTER.has_verified_graph(store))
        finally:
            store.close()
        changed_identity = {"package": "code-review-graph", "version": "test-runtime-change"}
        with patch.object(ADAPTER, "runtime_identity", return_value=changed_identity):
            with patch("code_review_graph.tools.build.build_or_update_graph", wraps=build_or_update_graph) as build:
                ADAPTER.refresh(self.root)
        self.assertEqual([call.kwargs["full_rebuild"] for call in build.call_args_list], [True])

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
        self.assertFalse(result.get("errors"))
        self.assertEqual(self.metadata("git_head_sha"), self.git("rev-parse", "HEAD"))

    def test_runtime_probe_is_read_only(self):
        with tempfile.TemporaryDirectory(prefix="codemap-runtime-probe-") as target:
            command = [sys.executable, "-I", "-B", str(Path(ADAPTER.__file__).resolve()), "--check-runtime"]
            probe = subprocess.run(command, cwd=target, capture_output=True, text=True, timeout=30)
            self.assertEqual(probe.returncode, 0, probe.stderr)
            self.assertIn('"status": "ok"', probe.stdout)
            rejected = subprocess.run(command + ["build", "--repo", target], cwd=target,
                                      capture_output=True, text=True, timeout=30)
            self.assertEqual(rejected.returncode, 2)
            self.assertEqual(list(Path(target).iterdir()), [])

    def test_graph_paths_accept_native_and_posix_separators(self):
        store, _ = _get_store(str(self.root))
        try:
            for stored in store.get_all_files():
                store._conn.execute("UPDATE nodes SET file_path = ? WHERE file_path = ?",
                                    (Path(stored).as_posix(), stored))
            store.commit()
            snapshot = ADAPTER.source_snapshot(self.root)
            self.assertTrue(ADAPTER.graph_matches(self.root, store, snapshot[0]))
            self.source.write_text("function changedAgain() {}\n", encoding="utf-8")
            self.assertFalse(ADAPTER.graph_matches(self.root, store, ADAPTER.source_snapshot(self.root)[0]))
        finally:
            store.close()

    def test_full_rebuild_removes_legacy_path_aliases_and_references(self):
        """完整重建必须清除旧 raw 路径的节点及跨文件引用。"""
        store, _ = _get_store(str(self.root))
        try:
            self.assertTrue(ADAPTER.has_verified_graph(store))
            canonical_path = next(
                path for path in store.get_all_files()
                if path.replace("\\", "/") == self.source.as_posix()
            )
            canonical_node = store._conn.execute(
                "SELECT qualified_name FROM nodes WHERE file_path = ? "
                "AND kind = 'Function' LIMIT 1",
                (canonical_path,),
            ).fetchone()[0]
            legacy_path = canonical_path.replace("\\", "\\\\").replace("/", "\\\\")
            legacy_node = f"{legacy_path}::legacy"

            # 这类旧记录无法由 2.3.8 的 NodeInfo 创建：它会在写入前规范化
            # 分隔符；直接 seed 夹具才能覆盖历史数据库兼容路径。
            store._conn.execute(
                "INSERT INTO nodes "
                "(kind, name, qualified_name, file_path, line_start, line_end, "
                "language, parent_name, params, return_type, modifiers, is_test, "
                "file_hash, extra, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("File", legacy_path, legacy_node, legacy_path, 1, 1,
                 "javascript", None, None, None, None, 0, "stale-hash", "{}", 0),
            )
            for source, target, file_path in (
                (legacy_node, canonical_node, legacy_path),
                (canonical_node, legacy_node, canonical_path),
            ):
                edge_values = {
                    "kind": "CALLS", "source_qualified": source,
                    "target_qualified": target, "file_path": file_path,
                    "line": 1, "extra": "{}", "confidence": 1.0,
                    "confidence_tier": "EXTRACTED", "updated_at": 0,
                }
                columns = [row[1] for row in store._conn.execute("PRAGMA table_info(edges)")]
                names = [name for name in edge_values if name in columns]
                store._conn.execute(
                    f"INSERT INTO edges ({', '.join(names)}) "
                    f"VALUES ({', '.join('?' for _ in names)})",
                    [edge_values[name] for name in names],
                )
            store._conn.execute(
                "CREATE TABLE IF NOT EXISTS embeddings (qualified_name TEXT PRIMARY KEY)"
            )
            store._conn.execute(
                "INSERT INTO embeddings(qualified_name) VALUES (?)", (legacy_node,)
            )
            store.commit()
            self.assertIn(legacy_path, store.get_all_files())
            self.assertEqual(store._conn.execute(
                "SELECT file_hash FROM nodes WHERE file_path = ?", (legacy_path,)
            ).fetchone()[0], "stale-hash")
            self.assertFalse(ADAPTER.graph_matches(
                self.root, store, ADAPTER.source_snapshot(self.root)[0]
            ))
        finally:
            store.close()

        result = ADAPTER.refresh(self.root)
        self.assertFalse(result.get("errors"))
        store, _ = _get_store(str(self.root))
        try:
            self.assertNotIn(legacy_path, store.get_all_files())
            self.assertEqual(store._conn.execute(
                "SELECT COUNT(*) FROM nodes WHERE file_path = ?", (legacy_path,)
            ).fetchone()[0], 0)
            self.assertEqual(store._conn.execute(
                "SELECT COUNT(*) FROM edges WHERE file_path = ? "
                "OR source_qualified = ? OR target_qualified = ?",
                (legacy_path, legacy_node, legacy_node),
            ).fetchone()[0], 0)
            self.assertEqual(store._conn.execute(
                "SELECT COUNT(*) FROM embeddings WHERE qualified_name = ?", (legacy_node,)
            ).fetchone()[0], 0)
            self.assertTrue(ADAPTER.graph_matches(
                self.root, store, ADAPTER.source_snapshot(self.root)[0]
            ))
        finally:
            store.close()

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
