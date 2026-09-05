"""通过隔离 CRG API 刷新并核对源码，避免零变化更新留下旧提交编号。"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

VERIFIED_KEY = "codemap_verified_inventory_v1"


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
    from code_review_graph.incremental import CodeParser, normalize_file_path

    expected = {normalize_file_path(root / name) for name in files}
    if set(store.get_all_files()) - expected:
        return False
    parser = None
    for name, digest in files.items():
        full_path = root / name
        nodes = store.get_nodes_by_file(str(full_path))
        if nodes:
            if any(node.file_hash != digest for node in nodes):
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


def proof_for(store, files: dict[str, str]) -> dict:
    inventory = json.dumps(files, sort_keys=True, ensure_ascii=True).encode()
    return {
        "inventory": hashlib.sha256(inventory).hexdigest(),
        "updated": store.get_metadata("last_updated"),
        "postprocessed": store.get_metadata("last_postprocessed_at"),
    }


def has_verified_graph(store) -> bool:
    try:
        proof = json.loads(store.get_metadata(VERIFIED_KEY) or "null")
        return (isinstance(proof, dict) and bool(proof.get("inventory"))
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


def refresh(root: Path, full: bool = False) -> dict:
    """成功返回时源码快照稳定、图内容一致；提交推进无需重复解析整图。"""
    from code_review_graph.tools._common import _get_store
    from code_review_graph.tools.build import build_or_update_graph

    # Git 自身识别普通仓库、父级仓库和 worktree 的 .git 文件。
    # 非 Git 目录在收集源码或打开图数据库之前退出。
    root = Path(git_value(root.resolve(), "rev-parse", "--show-toplevel")).resolve()
    before = source_snapshot(root)
    store, _ = _get_store(str(root))
    try:
        # 旧版成功标记不能证明后处理完整，首次迁移只做一次完整验证。
        full = full or not has_verified_graph(store)
    finally:
        store.close()
    try:
        for attempt in range(2):
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
                    if matched:
                        head, branch = before[1:]
                        advanced = bool(head and store.get_metadata("git_head_sha") != head)
                        values = [(VERIFIED_KEY, json.dumps(proof_for(store, before[0])))]
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
    parser.add_argument("action", choices=("build", "update"))
    parser.add_argument("--repo", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(refresh(args.repo, args.action == "build"), ensure_ascii=False))
        return 0
    except Exception as error:
        print(f"CodeMap refresh failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
