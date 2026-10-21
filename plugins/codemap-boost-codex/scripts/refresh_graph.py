"""Refresh and verify source through the isolated CRG API so no-op updates do not retain stale commit IDs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

VERIFIED_KEY = "codemap_verified_inventory_v2"


def install_cpp_anonymous_resolution() -> None:
    """Apply unnamed-namespace lookup only inside the managed parse process.

    CRG 2.3.9 omits the implicit using-directive of an unnamed namespace.
    Work with parsed same-file declarations, preserve overload ambiguity, and
    never infer an object receiver or bind a symbol from another translation unit.
    Upstream package files are not modified.
    """
    from dataclasses import replace
    import concurrent.futures
    from code_review_graph import incremental
    from code_review_graph.parser import CodeParser

    if not callable(getattr(CodeParser, '_node_qualified', None)):
        raise RuntimeError('CodeMap requires CRG >= 2.3.8 with scoped C++ symbols; upgrade the managed runtime')
    # Spawned process workers import upstream afresh and lose this adapter.
    # Thread workers retain it and upstream keeps each parser thread-local.
    incremental._make_executor = lambda max_workers: concurrent.futures.ThreadPoolExecutor(
        max_workers=max_workers)
    original = CodeParser._resolve_call_targets
    if getattr(original, '_codemap_anonymous_lookup', False):
        return

    def resolve(self, nodes, edges, file_path):
        resolved = original(self, nodes, edges, file_path)
        if len(resolved) != len(edges):
            return resolved
        functions = [n for n in nodes if n.language == 'cpp'
                     and n.kind in ('Function', 'Test') and n.file_path == file_path]
        if not any('(anonymous)' in (n.parent_name or '') for n in functions):
            return resolved
        scopes = {self._node_qualified(n): n.parent_name for n in functions}
        declarations = {}
        for node in functions:
            declarations.setdefault(node.name, {})[self._node_qualified(node)] = node

        def visible(parent, scope):
            # Only trailing anonymous namespaces inject declarations into their
            # parent. A named child or class inside one is not a free function.
            while parent != scope and parent and parent.split('.')[-1] == '(anonymous)':
                parent = parent.rsplit('.', 1)[0] if '.' in parent else None
            return parent == scope

        replacements = {}
        for index, edge in enumerate(edges):
            if (edge.kind != 'CALLS' or edge.source not in scopes or '::' in edge.target
                    or edge.extra.get('receiver') or edge.extra.get('receiver_form')):
                continue
            entries = declarations.get(edge.target, {})
            if not any('(anonymous)' in (n.parent_name or '') for n in entries.values()):
                continue
            scope = scopes[edge.source]
            while True:
                matches = [qn for qn, n in entries.items() if visible(n.parent_name, scope)]
                if matches or scope is None:
                    break
                scope = scope.rsplit('.', 1)[0] if '.' in scope else None
            if not matches:
                continue
            extra = {k: v for k, v in edge.extra.items()
                     if not k.startswith(('unresolved_target', 'ambiguous_target'))}
            if len(matches) > 1:
                extra.update(ambiguous_targets=sorted(matches)[:20],
                             ambiguous_target_count=len(matches),
                             ambiguous_targets_truncated=len(matches) > 20)
            replacements[index] = replace(
                edge, target=matches[0] if len(matches) == 1 else edge.target, extra=extra)
        # One output per original edge: file/line alone cannot distinguish two
        # different calls, or a free call and receiver call, on the same line.
        return [replacements.get(index, edge) for index, edge in enumerate(resolved)]

    resolve._codemap_anonymous_lookup = True
    CodeParser._resolve_call_targets = resolve


def runtime_identity() -> dict[str, str]:
    """Return the identity of the imported CRG package without inferring it from directories or version branches."""
    from importlib.metadata import version

    return {"package": "code-review-graph", "version": version("code-review-graph"),
            "adapter": "cpp-anonymous-lookup-v2"}


def check_runtime() -> dict:
    """Validate adapter interfaces and parsers read-only, without opening or changing user graph databases."""
    from importlib.metadata import version
    from code_review_graph.graph import GraphStore
    from code_review_graph.incremental import collect_all_files
    from code_review_graph.parser import CodeParser, NodeInfo
    from code_review_graph.tools._common import _get_store
    from code_review_graph.tools.build import build_or_update_graph

    install_cpp_anonymous_resolution()
    for member in (collect_all_files, _get_store, build_or_update_graph,
                   CodeParser._resolve_call_targets, CodeParser._node_qualified,
                   GraphStore.get_all_files, GraphStore.get_nodes_by_file,
                   GraphStore.remove_file_data,
                   GraphStore.store_file_nodes_edges,
                   GraphStore.get_metadata, GraphStore.close):
        if not callable(member):
            raise RuntimeError("CRG refresh interface is not callable")
    parser = CodeParser(Path.cwd())
    nodes, _ = parser.parse_bytes(Path.cwd() / "codemap_runtime_probe.js",
                                  b"function codemapRuntimeProbe() { return 1; }\n")
    if not any(node.name == "codemapRuntimeProbe" for node in nodes):
        raise RuntimeError("CRG refresh parser probe did not produce expected nodes")
    cpp_nodes, cpp_edges = parser.parse_bytes(
        Path.cwd() / "codemap_runtime_probe.cc",
        b"namespace { int helper(){return 1;} } int run(){return helper();}")
    helper = next((n for n in cpp_nodes if n.name == "helper"), None)
    if helper is None or not any(e.kind == "CALLS" and e.target == parser._node_qualified(helper)
                                 for e in cpp_edges):
        raise RuntimeError("CRG C++ unnamed namespace lookup probe failed")
    # Raw-path cleanup depends on existing SQLite columns; validate this contract in a temporary database
    # across 2.3.x without opening, creating, or refreshing user repository graphs.
    with tempfile.TemporaryDirectory(prefix="codemap-runtime-contract-") as target:
        target_path = Path(target)
        store = GraphStore(target_path / "graph.db")
        try:
            canonical = str(target_path / "source.js")
            current = NodeInfo(
                kind="File", name=canonical, file_path=canonical,
                line_start=1, line_end=1, language="javascript",
            )
            store.store_file_nodes_edges(canonical, [current], [], "current-hash")
            legacy = canonical.replace("\\", "\\\\").replace("/", "\\\\")
            legacy_node = f"{legacy}::legacy"
            store._conn.execute(
                "INSERT INTO nodes "
                "(kind, name, qualified_name, file_path, line_start, line_end, "
                "language, parent_name, params, return_type, modifiers, is_test, "
                "file_hash, extra, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("File", legacy, legacy_node, legacy, 1, 1, "javascript",
                 None, None, None, None, 0, "legacy-hash", "{}", 0),
            )
            store._conn.execute(
                "INSERT INTO edges(kind, source_qualified, target_qualified, file_path, "
                "line, extra, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("CALLS", legacy_node, current.name, canonical, 1, "{}", 0),
            )
            store._conn.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
                ("codemap_runtime_contract", "preserve"),
            )
            store.commit()
            clear_file_backed_graph(store)
            if store.get_all_files():
                raise RuntimeError("CRG refresh cleanup retained file graph records")
            if store._conn.execute(
                "SELECT 1 FROM edges WHERE source_qualified = ? OR target_qualified = ?",
                (legacy_node, legacy_node),
            ).fetchone():
                raise RuntimeError("CRG refresh cleanup retained reference edges for old paths")
            if store.get_metadata("codemap_runtime_contract") != "preserve":
                raise RuntimeError("CRG refresh cleanup incorrectly deleted metadata")
        finally:
            store.close()
    return {"status": "ok", "crg_version": version("code-review-graph")}


def sha256_file(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(64 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def git_value(root: Path, *args: str, allow_unborn: bool = False) -> str:
    result = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, timeout=30,
        check=False,
    )
    if allow_unborn and result.returncode == 1:
        return ""
    if result.returncode:
        raise RuntimeError("Cannot verify Git status")
    return result.stdout.strip()


def source_snapshot(root: Path) -> tuple[dict[str, str], str, str]:
    """Use CRG file scope without scanning adjacent repositories or ignored files."""
    from code_review_graph.incremental import collect_all_files

    files = {
        name: sha256_file(root / name)
        for name in collect_all_files(root)
    }
    head = git_value(root, "rev-parse", "--verify", "--quiet", "HEAD", allow_unborn=True)
    branch = git_value(root, "rev-parse", "--abbrev-ref", "HEAD") if head else ""
    return files, head, branch


def graph_matches(root: Path, store, files: dict[str, str]) -> bool:
    """Verify the full file list and contents; confirm node-free empty files through parser results."""
    from code_review_graph.parser import CodeParser

    # CRG 2.3.7 stores native paths; newer versions may store POSIX paths.
    # Normalize paths only for comparison; query original database values without upstream internal helpers.
    def path_key(value) -> str:
        return os.path.normcase(str(Path(value).resolve()))

    expected = {path_key(root / name) for name in files}
    stored_paths = {}
    for stored in store.get_all_files():
        stored_paths.setdefault(path_key(stored), []).append(stored)
    if set(stored_paths) - expected:
        return False
    parser = None
    for name, digest in files.items():
        full_path = root / name
        raw_paths = stored_paths.get(path_key(full_path), [])
        # Each source file must have one graph path identity. Even if alias hashes currently match,
        # later incremental updates could retain stale nodes or edges.
        if len(raw_paths) > 1:
            return False
        # In 2.3.8, get_nodes_by_file normalizes query arguments and cannot read historical raw
        # Windows double-separator records. Read exact raw-path hashes to keep verification conservative.
        nodes = [] if not raw_paths else store._conn.execute(
            "SELECT file_hash FROM nodes WHERE file_path = ?", (raw_paths[0],)
        ).fetchall()
        if nodes:
            if any(node["file_hash"] != digest for node in nodes):
                return False
        else:
            # CRG creates no nodes for some empty files; this must not trigger repeated rebuilds.
            parser = parser or CodeParser(root)
            nodes, edges = parser.parse_bytes(full_path, full_path.read_bytes())
            if nodes or edges:
                return False
    return True


def check_result(result: dict) -> None:
    if result.get("status") != "ok" or result.get("errors") or result.get("warnings"):
        raise RuntimeError("CRG refresh or postprocessing did not fully pass; cannot mark it current")


def proof_for(store, files: dict[str, str], runtime: dict[str, str]) -> dict:
    inventory = json.dumps(files, sort_keys=True, ensure_ascii=True).encode()
    return {
        "inventory": hashlib.sha256(inventory).hexdigest(),
        "runtime": runtime,
        "updated": store.get_metadata("last_updated"),
        "postprocessed": store.get_metadata("last_postprocessed_at"),
        "structure": structure_digest(store),
    }


def structure_digest(store) -> str:
    """Cover application table schemas/rows while allowing independent vector writes; the caller must hold a SQLite write lock.

    Exclude embeddings, SQLite internals, and the proof itself; git_head_sha/git_branch
    may advance when commits change without source changes. Include nodes, edges, derived tables, FTS (including shadows), other
    metadata, and extra application objects; node file_hash alone must not hide external graph modifications.
    """
    digest = hashlib.sha256()

    def encode(value):
        return {"blob": value.hex()} if isinstance(value, bytes) else value

    def add(value):
        digest.update(json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode())
        digest.update(b"\n")

    def quote(identifier):
        return '"' + identifier.replace('"', '""') + '"'

    objects = store._conn.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name COLLATE BINARY"
    ).fetchall()
    for item in objects:
        kind, name, table, sql = tuple(item)
        if name.startswith("sqlite_") or table == "embeddings":
            continue
        add([kind, name, table, sql])
        if kind != "table":
            continue
        columns = [row[1] for row in store._conn.execute(f"PRAGMA table_info({quote(name)})")]
        order = ", ".join(f"{quote(column)} COLLATE BINARY" for column in columns)
        query = f"SELECT * FROM {quote(name)}"
        args = ()
        if name == "metadata":
            query += " WHERE key NOT IN (?, ?, ?)"
            args = (VERIFIED_KEY, "git_head_sha", "git_branch")
        query += f" ORDER BY {order}"
        for row in store._conn.execute(query, args):
            add([encode(value) for value in row])
    return digest.hexdigest()


def has_verified_graph(store, runtime: dict[str, str] | None = None) -> bool:
    try:
        runtime = runtime or runtime_identity()
        proof = json.loads(store.get_metadata(VERIFIED_KEY) or "null")
        return (isinstance(proof, dict) and bool(proof.get("inventory"))
                and bool(proof.get("structure"))
                and proof.get("runtime") == runtime
                and proof.get("updated") == store.get_metadata("last_updated")
                and proof.get("postprocessed") == store.get_metadata("last_postprocessed_at")
                and proof.get("structure") == structure_digest(store))
    except (ValueError, TypeError):
        return False


def invalidate(root: Path) -> None:
    """Upstream may advance SHA before reporting parser failure; conservatively revoke trusted state on failure."""
    from code_review_graph.tools._common import _get_store

    store, _ = _get_store(str(root))
    try:
        with store._conn:
            store._conn.execute("BEGIN IMMEDIATE")
            store._conn.execute("DELETE FROM metadata WHERE key = ?", (VERIFIED_KEY,))
            store._conn.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
                ("git_head_sha", ""),
            )
    finally:
        store.close()


def clear_file_backed_graph(store) -> None:
    """Remove old file graph records before full rebuilds, preserving metadata and provenance."""
    file_paths = list(dict.fromkeys(store.get_all_files()))
    if not file_paths:
        return

    has_embeddings = store._conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'"
    ).fetchone() is not None
    store._conn.execute("BEGIN IMMEDIATE")
    try:
        for file_path in file_paths:
            # Clean references while all raw identities still exist, preventing 2.3.8 path normalization from
            # deleting new-path nodes before later aliases can locate their embeddings or cross-file edges.
            if has_embeddings:
                store._conn.execute(
                    "DELETE FROM embeddings WHERE qualified_name IN "
                    "(SELECT qualified_name FROM nodes WHERE file_path = ?)",
                    (file_path,),
                )
            store._conn.execute(
                "DELETE FROM edges WHERE file_path = ? "
                "OR source_qualified IN "
                "(SELECT qualified_name FROM nodes WHERE file_path = ?) "
                "OR target_qualified IN "
                "(SELECT qualified_name FROM nodes WHERE file_path = ?)",
                (file_path, file_path, file_path),
            )
        for file_path in file_paths:
            # 2.3.7 can delete raw paths directly; 2.3.8 normalizes arguments. Both first use
            # the upstream API, then exact raw-path cleanup for legacy double-separator databases.
            store.remove_file_data(file_path)
            store._conn.execute("DELETE FROM nodes WHERE file_path = ?", (file_path,))
        store._conn.commit()
    except BaseException:
        store._conn.rollback()
        raise


def verify_and_record(root: Path, store, snapshot, runtime, prior_proof: bool = False):
    """Verify source and structure in a consistent transaction; advance proof/provenance only on success."""
    with store._conn:
        store._conn.execute("BEGIN IMMEDIATE")
        trusted = True
        if prior_proof:
            trusted = has_verified_graph(store, runtime)
            if trusted:
                proof = json.loads(store.get_metadata(VERIFIED_KEY))
                inventory = hashlib.sha256(json.dumps(
                    snapshot[0], sort_keys=True, ensure_ascii=True
                ).encode()).hexdigest()
                trusted = proof["inventory"] == inventory
        matched = trusted and graph_matches(root, store, snapshot[0])
        if source_snapshot(root) != snapshot:
            raise RuntimeError("Source or commit changed during verification; retry")
        if runtime_identity() != runtime:
            raise RuntimeError("CRG runtime changed during verification; retry")
        if not matched:
            return None
        head, branch = snapshot[1:]
        advanced = bool(head and store.get_metadata("git_head_sha") != head)
        values = [(VERIFIED_KEY, json.dumps(proof_for(store, snapshot[0], runtime)))]
        if head:
            values.extend([("git_branch", branch), ("git_head_sha", head)])
        # Preserve last_updated; verified/no-op results must not pretend to reparse.
        store._conn.executemany("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)", values)
        return advanced


def refresh(root: Path, full: bool = False, verify: bool = False) -> dict:
    """Success guarantees a stable source snapshot and consistent graph; commit advancement does not require full reparsing."""
    from code_review_graph.tools._common import _get_store
    from code_review_graph.tools.build import build_or_update_graph

    install_cpp_anonymous_resolution()

    # Git identifies ordinary/parent repositories and linked worktree .git files.
    # Exit non-Git directories before collecting source or opening the graph database.
    root = Path(git_value(root.resolve(), "rev-parse", "--show-toplevel")).resolve()
    before = source_snapshot(root)
    runtime = runtime_identity()
    store, _ = _get_store(str(root))
    try:
        if not full:
            try:
                advanced = verify_and_record(root, store, before, runtime, prior_proof=True)
            except Exception:
                store.close()
                invalidate(root)
                raise
            if advanced is not None:
                return {"status": "ok", "build_type": "verified", "files_updated": 0,
                        "codemap_metadata_advanced": advanced}
            # Source hashes alone cannot approve database changes; an explicit verify with mismatched
            # or missing structure proof performs a full repair. Ordinary source updates may remain incremental.
            if verify:
                full = True
        # Legacy success markers cannot prove complete postprocessing; perform one full verification on migration.
        with store._conn:
            store._conn.execute("BEGIN IMMEDIATE")
            full = full or not has_verified_graph(store, runtime)
    finally:
        store.close()
    try:
        for attempt in range(2):
            if full:
                store, _ = _get_store(str(root))
                try:
                    clear_file_backed_graph(store)
                finally:
                    store.close()
            result = build_or_update_graph(full_rebuild=full, repo_root=str(root))
            check_result(result)
            store, _ = _get_store(str(root))
            try:
                advanced = verify_and_record(root, store, before, runtime)
                if advanced is not None:
                    return {**result, "codemap_metadata_advanced": advanced}
            finally:
                store.close()
            if full or attempt:
                raise RuntimeError("Graph contents still differ from source after refresh")
            # Escalate to a full build only for actual content mismatches, such as restored dirty files.
            full = True
    except Exception:
        invalidate(root)
        raise
    raise RuntimeError("Graph refresh did not complete")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", choices=("build", "update", "verify"))
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--check-runtime", action="store_true")
    args = parser.parse_args()
    if args.check_runtime and (args.action or args.repo):
        parser.error("--check-runtime cannot be combined with refresh arguments")
    if not args.check_runtime and (not args.action or args.repo is None):
        parser.error("Refresh requires action and --repo")
    try:
        result = check_runtime() if args.check_runtime else refresh(
            args.repo, full=args.action == "build", verify=args.action == "verify"
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(f"CodeMap refresh failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
