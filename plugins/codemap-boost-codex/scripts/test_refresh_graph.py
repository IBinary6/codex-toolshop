"""Verify the refresh lifecycle with real CRG, temporary Git repositories, and SQLite."""

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import struct
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
    def test_parallel_cpp_build_keeps_adapter_resolution(self):
        # Cross the upstream parallel threshold; spawned upstream workers used
        # to lose the adapter although single-file parser tests passed.
        for index in range(10):
            (self.root / f"anonymous{index}.cc").write_text(
                "namespace {int helper(){return 1;}} int run(){return helper();}",
                encoding="utf-8")
        self.git("add", ".")
        with patch.dict(os.environ, {"CRG_PARSE_EXECUTOR": "process"}):
            ADAPTER.refresh(self.root, full=True)
        store, _ = _get_store(str(self.root))
        try:
            calls = store._conn.execute(
                "SELECT target_qualified, extra FROM edges WHERE kind='CALLS' "
                "AND file_path LIKE '%anonymous%.cc'").fetchall()
            self.assertEqual(len(calls), 10)
            for target, extra in calls:
                self.assertIn('(anonymous).helper()', target)
                self.assertNotIn('unresolved_targets', json.loads(extra))
        finally:
            store.close()

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

    def refresh_through_js_barrier(self):
        """Exercise real JS/source-marker/temp-index/adapter paths without loading embedding providers."""
        library = Path(__file__).resolve().parents[1] / "hooks/js/lib/codemap.js"
        command = Path(sys.executable).with_name(
            "code-review-graph.exe" if os.name == "nt" else "code-review-graph"
        )
        script = """
const codemap = require(process.env.CODEMAP_TEST_LIBRARY);
const diagnostics = [];
const ok = codemap.refreshCrgSync(process.env.CODEMAP_TEST_ROOT, {
  canUseCrg: () => true, crgCommand: process.env.CODEMAP_TEST_COMMAND, diagnostics,
});
console.log(JSON.stringify({ok, diagnostics}));
process.exit(ok ? 0 : 1);
"""
        env = {**os.environ, "CODEMAP_TEST_LIBRARY": str(library),
               "CODEMAP_TEST_ROOT": str(self.root), "CODEMAP_TEST_COMMAND": str(command)}
        env.pop("CODEMAP_BOOST_DISABLE_GRAPH", None)
        result = subprocess.run(["node", "-e", script], cwd=self.root, env=env,
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def seed_embeddings(self):
        from code_review_graph.embeddings import _node_to_text

        store, _ = _get_store(str(self.root))
        try:
            store._conn.execute(
                "CREATE TABLE IF NOT EXISTS embeddings (qualified_name TEXT PRIMARY KEY, "
                "vector BLOB NOT NULL, text_hash TEXT NOT NULL, provider TEXT NOT NULL)"
            )
            for node in store.get_all_nodes(exclude_files=True):
                text_hash = hashlib.sha256(_node_to_text(node).encode()).hexdigest()
                store._conn.execute("INSERT OR REPLACE INTO embeddings VALUES (?, ?, ?, ?)",
                                    (node.qualified_name, struct.pack("2f", 1.0, 0.0),
                                     text_hash, "local:test-fixture"))
            store.commit()
            return [tuple(row) for row in store._conn.execute(
                "SELECT * FROM embeddings ORDER BY qualified_name"
            )]
        finally:
            store.close()

    def test_embedding_write_then_real_barrier_preserves_vectors_with_untracked_source(self):
        (self.root / "untracked.js").write_text("function untracked() { return 4; }\n", encoding="utf-8")
        real_index = self.git("ls-files", "--stage")
        self.refresh_through_js_barrier()
        parsed_at = self.metadata("last_updated")
        before = self.seed_embeddings()
        self.assertTrue(before)
        self.refresh_through_js_barrier()
        store, _ = _get_store(str(self.root))
        try:
            after = [tuple(row) for row in store._conn.execute(
                "SELECT * FROM embeddings ORDER BY qualified_name"
            )]
            self.assertEqual(after, before, "graph-only database writes must not erase explicitly generated vectors")
        finally:
            store.close()
        self.assertEqual(self.git("ls-files", "--stage"), real_index)
        self.assertIn("?? untracked.js", self.git("status", "--porcelain"))
        self.assertEqual(self.metadata("last_updated"), parsed_at)

    def test_verify_only_and_fts_read_do_not_reparse_or_load_provider(self):
        before = self.seed_embeddings()
        store, _ = _get_store(str(self.root))
        try:
            store._conn.execute("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'original'").fetchall()
        finally:
            store.close()
        with patch("code_review_graph.tools.build.build_or_update_graph", wraps=build_or_update_graph) as build:
            result = ADAPTER.refresh(self.root, verify=True)
        build.assert_not_called()
        self.assertEqual(result["build_type"], "verified")
        store, _ = _get_store(str(self.root))
        try:
            self.assertEqual([tuple(row) for row in store._conn.execute(
                "SELECT * FROM embeddings ORDER BY qualified_name")], before)
        finally:
            store.close()

    def test_verify_detects_added_business_table_and_changed_fts(self):
        for change in ("new-table", "fts"):
            with self.subTest(change=change):
                store, _ = _get_store(str(self.root))
                try:
                    if change == "new-table":
                        store._conn.execute("CREATE TABLE external_graph_state(value TEXT)")
                        store._conn.execute("INSERT INTO external_graph_state VALUES ('added')")
                    else:
                        store._conn.execute("DELETE FROM nodes_fts")
                    store.commit()
                finally:
                    store.close()

                with patch("code_review_graph.tools.build.build_or_update_graph", wraps=build_or_update_graph) as build:
                    result = ADAPTER.refresh(self.root, verify=True)
                self.assertEqual([call.kwargs["full_rebuild"] for call in build.call_args_list], [True])
                self.assertEqual(result["build_type"], "full")
                store, _ = _get_store(str(self.root))
                try:
                    self.assertTrue(store._conn.execute(
                        "SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'original'").fetchall())
                finally:
                    store.close()

    def test_verify_failure_invalidates_graph_proof(self):
        self.seed_embeddings()
        with patch.object(ADAPTER, "graph_matches", side_effect=RuntimeError("injected verify failure")):
            with self.assertRaisesRegex(RuntimeError, "injected verify failure"):
                ADAPTER.refresh(self.root, verify=True)
        self.assertIsNone(self.metadata(ADAPTER.VERIFIED_KEY))
        self.assertEqual(self.metadata("git_head_sha"), "")

    def test_untracked_edit_after_embedding_still_refreshes_source(self):
        untracked = self.root / "untracked.js"
        untracked.write_text("function beforeEdit() { return 4; }\n", encoding="utf-8")
        self.refresh_through_js_barrier()
        self.seed_embeddings()
        untracked.write_text("function afterEdit() { return 5; }\n", encoding="utf-8")
        self.refresh_through_js_barrier()
        store, _ = _get_store(str(self.root))
        try:
            nodes = store.get_nodes_by_file(str(untracked))
            names = {node.name for node in nodes}
            self.assertIn("afterEdit", names)
            self.assertNotIn("beforeEdit", names)
            # The real Git index still excludes untracked files; verify content hashes by graph node identity,
            # rather than rejecting correct temporary-index graphs using snapshots that exclude untracked files.
            for node in nodes:
                stored = store._conn.execute("SELECT file_hash FROM nodes WHERE qualified_name = ?",
                                             (node.qualified_name,)).fetchone()[0]
                self.assertEqual(stored, ADAPTER.sha256_file(untracked))
        finally:
            store.close()

    def test_graph_row_tamper_after_embedding_is_repaired_by_real_barrier(self):
        (self.root / "untracked.js").write_text("function untracked() { return 4; }\n", encoding="utf-8")
        self.refresh_through_js_barrier()
        self.seed_embeddings()
        store, _ = _get_store(str(self.root))
        try:
            store._conn.execute("UPDATE nodes SET name = 'tampered' WHERE name = 'original'")
            store.commit()
        finally:
            store.close()
        self.refresh_through_js_barrier()
        store, _ = _get_store(str(self.root))
        try:
            names = {node.name for node in store.get_nodes_by_file(str(self.source))}
            self.assertIn("original", names)
            self.assertNotIn("tampered", names)
        finally:
            store.close()

    def test_commit_after_indexing_advances_without_reparse(self):
        self.source.write_text("function changed() { return 2; }\n", encoding="utf-8")
        ADAPTER.refresh(self.root)
        parsed_at = self.metadata("last_updated")
        self.git("add", "sample.js")
        self.git("commit", "--quiet", "-m", "source already indexed")
        # Commit already-indexed source: advance provenance without upstream reparsing or timestamp changes.
        upstream = {"status": "ok", "files_updated": 0}
        self.assertNotEqual(self.metadata("git_head_sha"), self.git("rev-parse", "HEAD"))
        with patch("code_review_graph.tools.build.build_or_update_graph", return_value=upstream) as build:
            result = ADAPTER.refresh(self.root)
        build.assert_not_called()
        self.assertEqual(result["files_updated"], 0)
        self.assertTrue(result["codemap_metadata_advanced"])
        self.assertEqual(self.metadata("git_head_sha"), self.git("rev-parse", "HEAD"))
        self.assertEqual(self.metadata("last_updated"), parsed_at)

    def test_empty_commit_and_repeat_do_not_rebuild(self):
        # Fix the parse time in the past and synchronize its trusted proof. If upstream no-op is called,
        # advance to a clearly different time to avoid false positives from same-second execution.
        parsed_at = "2000-01-01T00:00:00"
        store, _ = _get_store(str(self.root))
        try:
            with store._conn:
                store._conn.execute("BEGIN IMMEDIATE")
                store._conn.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)",
                                    ("last_updated", parsed_at))
                proof = ADAPTER.proof_for(store, ADAPTER.source_snapshot(self.root)[0],
                                          ADAPTER.runtime_identity())
                store._conn.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)",
                                    (ADAPTER.VERIFIED_KEY, json.dumps(proof)))
        finally:
            store.close()

        def advancing_noop(**kwargs):
            store, _ = _get_store(str(self.root))
            try:
                store.set_metadata("last_updated", "2099-01-01T00:00:00")
            finally:
                store.close()
            return {"status": "ok", "files_updated": 0}

        self.git("commit", "--allow-empty", "--quiet", "-m", "metadata only")
        with patch("code_review_graph.tools.build.build_or_update_graph", side_effect=advancing_noop) as build:
            first = ADAPTER.refresh(self.root)
            second = ADAPTER.refresh(self.root)
        build.assert_not_called()
        self.assertEqual(first["status"], "ok")
        self.assertEqual(self.metadata("git_head_sha"), self.git("rev-parse", "HEAD"))
        self.assertEqual(self.metadata("last_updated"), parsed_at)
        self.assertFalse(second["codemap_metadata_advanced"])

    def test_reverted_worktree_content_is_repaired(self):
        original = self.source.read_bytes()
        self.source.write_text("function temporary() { return 3; }\n", encoding="utf-8")
        ADAPTER.refresh(self.root)
        self.source.write_bytes(original)
        with patch("code_review_graph.tools.build.build_or_update_graph", wraps=build_or_update_graph) as build:
            ADAPTER.refresh(self.root)
        self.assertEqual(build.call_args_list[0].kwargs["full_rebuild"], False)
        store, _ = _get_store(str(self.root))
        try:
            names = {node.name for node in store.get_nodes_by_file(str(self.source))}
            self.assertIn("original", names)
            self.assertNotIn("temporary", names)
            self.assertTrue(ADAPTER.graph_matches(self.root, store, ADAPTER.source_snapshot(self.root)[0]))
        finally:
            store.close()

    def test_failed_parse_never_advances_metadata(self):
        self.git("commit", "--allow-empty", "--quiet", "-m", "must remain unverified")
        self.source.write_text("function parseMustFail() { return 2; }\n", encoding="utf-8")
        failure = {"status": "ok", "files_updated": 0, "errors": [{"file": "sample.js", "error": "parser failed"}]}
        with patch("code_review_graph.tools.build.build_or_update_graph", return_value=failure):
            with self.assertRaisesRegex(RuntimeError, "did not fully pass"):
                ADAPTER.refresh(self.root)
        self.assertEqual(self.metadata("git_head_sha"), "")
        self.assertIsNone(self.metadata(ADAPTER.VERIFIED_KEY))

    def test_concurrent_edit_is_not_marked_verified(self):
        self.git("commit", "--allow-empty", "--quiet", "-m", "concurrent edit")
        self.source.write_text("function beforeConcurrentEdit() { return 2; }\n", encoding="utf-8")

        def change_during_build(**kwargs):
            result = build_or_update_graph(**kwargs)
            self.source.write_text("function concurrent() {}\n", encoding="utf-8")
            return result

        with patch("code_review_graph.tools.build.build_or_update_graph", side_effect=change_during_build):
            with self.assertRaisesRegex(RuntimeError, "changed"):
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
                    with self.assertRaisesRegex(RuntimeError, "did not fully pass"):
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
        self.assertEqual([call.kwargs["full_rebuild"] for call in build.call_args_list], [True])

    def test_runtime_identity_change_rebuilds_a_verified_graph(self):
        """Changed runtime package identity must not reuse proof written by the old runtime."""
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

    def test_explicit_full_build_is_not_skipped(self):
        with patch("code_review_graph.tools.build.build_or_update_graph", wraps=build_or_update_graph) as build:
            result = ADAPTER.refresh(self.root, full=True)
        self.assertEqual([call.kwargs["full_rebuild"] for call in build.call_args_list], [True])
        self.assertEqual(result["build_type"], "full")
        store, _ = _get_store(str(self.root))
        try:
            self.assertTrue(ADAPTER.has_verified_graph(store))
            self.assertTrue(ADAPTER.graph_matches(self.root, store, ADAPTER.source_snapshot(self.root)[0]))
        finally:
            store.close()

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
        build.assert_not_called()
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
        """Full rebuilds must remove old raw-path nodes and cross-file references."""
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

            # 2.3.8 NodeInfo cannot create these legacy records because it normalizes
            # separators before writing; seed fixtures directly to cover legacy database compatibility.
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
                "CREATE TABLE IF NOT EXISTS embeddings (qualified_name TEXT PRIMARY KEY, "
                "vector BLOB NOT NULL, text_hash TEXT NOT NULL, provider TEXT NOT NULL)"
            )
            store._conn.execute(
                "INSERT INTO embeddings VALUES (?, ?, ?, ?)",
                (legacy_node, struct.pack("2f", 1.0, 0.0), "legacy-hash", "local:test-fixture"),
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
