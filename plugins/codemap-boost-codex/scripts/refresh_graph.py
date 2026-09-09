"""通过隔离 CRG API 刷新并核对源码，避免零变化更新留下旧提交编号。"""

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


def runtime_identity() -> dict[str, str]:
    """返回实际导入的 CRG 包身份，不根据目录或版本号分支猜测。"""
    from importlib.metadata import version

    return {"package": "code-review-graph", "version": version("code-review-graph")}


def check_runtime() -> dict:
    """只读验证适配器接口与解析器，不打开或修改用户图数据库。"""
    from importlib.metadata import version
    from code_review_graph.graph import GraphStore
    from code_review_graph.incremental import collect_all_files
    from code_review_graph.parser import CodeParser, NodeInfo
    from code_review_graph.tools._common import _get_store
    from code_review_graph.tools.build import build_or_update_graph

    for member in (collect_all_files, _get_store, build_or_update_graph,
                   GraphStore.get_all_files, GraphStore.get_nodes_by_file,
                   GraphStore.remove_file_data,
                   GraphStore.store_file_nodes_edges,
                   GraphStore.get_metadata, GraphStore.close):
        if not callable(member):
            raise RuntimeError("CRG 刷新接口不可调用")
    parser = CodeParser(Path.cwd())
    nodes, _ = parser.parse_bytes(Path.cwd() / "codemap_runtime_probe.js",
                                  b"function codemapRuntimeProbe() { return 1; }\n")
    if not any(node.name == "codemapRuntimeProbe" for node in nodes):
        raise RuntimeError("CRG 刷新解析探针没有生成预期节点")
    # 适配器的 raw-path 清理依赖已存在的 SQLite 表列；用临时库验证这份
    # 跨 2.3.x 的契约，绝不打开、创建或刷新用户仓库的图数据库。
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
                raise RuntimeError("CRG 刷新清理契约仍保留文件图记录")
            if store._conn.execute(
                "SELECT 1 FROM edges WHERE source_qualified = ? OR target_qualified = ?",
                (legacy_node, legacy_node),
            ).fetchone():
                raise RuntimeError("CRG 刷新清理契约仍保留旧路径引用边")
            if store.get_metadata("codemap_runtime_contract") != "preserve":
                raise RuntimeError("CRG 刷新清理契约错误删除 metadata")
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
        raise RuntimeError("无法核对 Git 状态")
    return result.stdout.strip()


def source_snapshot(root: Path) -> tuple[dict[str, str], str, str]:
    """使用 CRG 自身的文件范围，不额外扫描相邻仓库或忽略文件。"""
    from code_review_graph.incremental import collect_all_files

    files = {
        name: sha256_file(root / name)
        for name in collect_all_files(root)
    }
    head = git_value(root, "rev-parse", "--verify", "--quiet", "HEAD", allow_unborn=True)
    branch = git_value(root, "rev-parse", "--abbrev-ref", "HEAD") if head else ""
    return files, head, branch


def graph_matches(root: Path, store, files: dict[str, str]) -> bool:
    """核对完整文件清单与内容；空文件没有节点时按解析结果确认。"""
    from code_review_graph.parser import CodeParser

    # CRG 2.3.7 保存原生路径，较新版本可能保存 POSIX 路径。
    # 在比较边界统一路径，查询仍使用数据库原值，不依赖上游内部辅助函数。
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
        # 一份源码只能有一种图路径身份。否则即使两个别名的哈希暂时相同，
        # 后续增量更新仍会把旧节点或边留在图中。
        if len(raw_paths) > 1:
            return False
        # 2.3.8 的 get_nodes_by_file 会规范化查询参数，反而无法读取历史 raw
        # Windows 双分隔符记录。这里只读对应原始路径的哈希，保持验证保守。
        nodes = [] if not raw_paths else store._conn.execute(
            "SELECT file_hash FROM nodes WHERE file_path = ?", (raw_paths[0],)
        ).fetchall()
        if nodes:
            if any(node["file_hash"] != digest for node in nodes):
                return False
        else:
            # CRG 对部分空文件不生成节点；不能因此每次都触发重建。
            parser = parser or CodeParser(root)
            nodes, edges = parser.parse_bytes(full_path, full_path.read_bytes())
            if nodes or edges:
                return False
    return True


def check_result(result: dict) -> None:
    if result.get("status") != "ok" or result.get("errors") or result.get("warnings"):
        raise RuntimeError("CRG 刷新或后处理未完整通过，不能标记为最新")


def proof_for(store, files: dict[str, str], runtime: dict[str, str]) -> dict:
    inventory = json.dumps(files, sort_keys=True, ensure_ascii=True).encode()
    return {
        "inventory": hashlib.sha256(inventory).hexdigest(),
        "runtime": runtime,
        "updated": store.get_metadata("last_updated"),
        "postprocessed": store.get_metadata("last_postprocessed_at"),
    }


def has_verified_graph(store, runtime: dict[str, str] | None = None) -> bool:
    try:
        runtime = runtime or runtime_identity()
        proof = json.loads(store.get_metadata(VERIFIED_KEY) or "null")
        return (isinstance(proof, dict) and bool(proof.get("inventory"))
                and proof.get("runtime") == runtime
                and proof.get("updated") == store.get_metadata("last_updated")
                and proof.get("postprocessed") == store.get_metadata("last_postprocessed_at"))
    except (ValueError, TypeError):
        return False


def invalidate(root: Path) -> None:
    """上游可能在报告解析失败之前已推进 SHA；失败后保守撤销可信状态。"""
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
    """完整重建前删除旧文件图记录，保留图的元数据与 provenance。"""
    file_paths = list(dict.fromkeys(store.get_all_files()))
    if not file_paths:
        return

    has_embeddings = store._conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'"
    ).fetchone() is not None
    store._conn.execute("BEGIN IMMEDIATE")
    try:
        for file_path in file_paths:
            # 所有 raw identity 仍存在时先清理引用，避免 2.3.8 规范化旧路径后
            # 提前删除新路径节点，从而让后续别名找不到其 embeddings 或跨文件边。
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
            # 2.3.7 可直接按 raw 路径删除；2.3.8 会规范化其参数。两者都先
            # 走上游接口，再以精确 raw 路径收尾，兼容遗留双分隔符数据库。
            store.remove_file_data(file_path)
            store._conn.execute("DELETE FROM nodes WHERE file_path = ?", (file_path,))
        store._conn.commit()
    except BaseException:
        store._conn.rollback()
        raise


def refresh(root: Path, full: bool = False) -> dict:
    """成功返回时源码快照稳定、图内容一致；提交推进无需重复解析整图。"""
    from code_review_graph.tools._common import _get_store
    from code_review_graph.tools.build import build_or_update_graph

    # Git 自身识别普通仓库、父级仓库和 worktree 的 .git 文件。
    # 非 Git 目录在收集源码或打开图数据库之前退出。
    root = Path(git_value(root.resolve(), "rev-parse", "--show-toplevel")).resolve()
    before = source_snapshot(root)
    runtime = runtime_identity()
    store, _ = _get_store(str(root))
    try:
        # 旧版成功标记不能证明后处理完整，首次迁移只做一次完整验证。
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
                # GraphStore.set_metadata 自行提交；此处统一事务避免 SHA、分支和
                # 验证标记分批提交，也防止其他 SQLite 写者穿插在多次核对之间。
                with store._conn:
                    store._conn.execute("BEGIN IMMEDIATE")
                    matched = graph_matches(root, store, before[0])
                    if source_snapshot(root) != before:
                        raise RuntimeError("核对期间源码或提交发生变化，请重试")
                    if runtime_identity() != runtime:
                        raise RuntimeError("核对期间 CRG runtime 发生变化，请重试")
                    if matched:
                        head, branch = before[1:]
                        advanced = bool(head and store.get_metadata("git_head_sha") != head)
                        values = [(VERIFIED_KEY, json.dumps(proof_for(store, before[0], runtime)))]
                        if head:
                            values.extend([("git_branch", branch), ("git_head_sha", head)])
                        # 不改 last_updated，纯提交推进不冒充重新解析。
                        store._conn.executemany(
                            "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)", values,
                        )
                if matched:
                    return {**result, "codemap_metadata_advanced": advanced}
            finally:
                store.close()
            if full or attempt:
                raise RuntimeError("刷新后图内容仍与源码不一致")
            # 只有实际内容不一致（例如还原 dirty 文件）才升级完整构建。
            full = True
    except Exception:
        invalidate(root)
        raise
    raise RuntimeError("图刷新未完成")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", choices=("build", "update"))
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--check-runtime", action="store_true")
    args = parser.parse_args()
    if args.check_runtime and (args.action or args.repo):
        parser.error("--check-runtime 不能与刷新参数组合")
    if not args.check_runtime and (not args.action or args.repo is None):
        parser.error("刷新必须指定 action 和 --repo")
    try:
        result = check_runtime() if args.check_runtime else refresh(args.repo, args.action == "build")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(f"CodeMap refresh failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
