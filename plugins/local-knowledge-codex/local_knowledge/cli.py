"""Local Knowledge 命令行入口。

该入口支持直接执行 ``python local_knowledge/cli.py``，也支持作为
``local_knowledge.cli`` 模块调用。输出默认保持简洁；``--format json``
用于 hook 和自动化调用。
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    # 直接执行脚本时把插件根目录放入导入路径，保持和 console script 一致。
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from local_knowledge.errors import KnowledgeError
from local_knowledge.storage import KnowledgeBase


def _csv(value: str | None) -> list[str]:
    """解析 CLI 的逗号分隔 cues/tags。"""
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _add_output_options(parser: argparse.ArgumentParser) -> None:
    """为全局和子命令位置都注册输出参数，兼容常见调用顺序。"""
    parser.add_argument("--format", dest="sub_format", choices=("json", "text"),
                        default=None, help="输出格式")
    parser.add_argument("--db", dest="sub_db", default=None, help="SQLite 文件路径")


def build_parser() -> argparse.ArgumentParser:
    """创建 Local Knowledge CLI 参数解析器。

    Example:
        >>> build_parser().prog
        'knowledge-codex'
    """
    parser = argparse.ArgumentParser(prog="knowledge-codex",
                                     description="保存和召回本地知识")
    parser.add_argument("--db", default=None, help="SQLite 文件路径")
    parser.add_argument("--format", choices=("json", "text"), default="text",
                        help="输出格式")
    subparsers = parser.add_subparsers(dest="command", required=True)

    remember = subparsers.add_parser("remember", help="显式保存一条知识")
    remember.add_argument("--content", required=True)
    remember.add_argument("--kind", default="note",
                          choices=("bug", "preference", "fact", "note", "decision", "workflow"))
    remember.add_argument("--canonical-key", "--key", dest="canonical_key", default=None)
    remember.add_argument("--title", default=None)
    remember.add_argument("--cues", default=None)
    remember.add_argument("--tags", default=None)
    remember.add_argument("--scope-kind", default="global",
                          choices=("global", "workspace", "repository"))
    remember.add_argument("--scope-key", default="")
    remember.add_argument("--recall-policy", default=None,
                          choices=("pinned", "on_match", "manual"))
    remember.add_argument("--authority", default=None,
                          choices=("user_asserted", "verified_local", "imported"))
    remember.add_argument("--sensitivity", default=None,
                          choices=("normal", "confidential"))
    _add_output_options(remember)

    recall = subparsers.add_parser("recall", help="按线索召回相关知识")
    recall.add_argument("query", nargs="?", default="")
    recall.add_argument("--query", dest="query_option", default=None)
    recall.add_argument("--query-b64", default=None)
    recall.add_argument("--scope-kind", default=None,
                        choices=("global", "workspace", "repository"))
    recall.add_argument("--scope-key", default=None)
    recall.add_argument("--policy", "--recall-policy", dest="policy", default=None,
                        choices=("pinned", "on_match", "manual"))
    recall.add_argument("--occasion", default=None)
    recall.add_argument("--explicit", action="store_true")
    recall.add_argument("--limit", type=int, default=5)
    recall.add_argument("--max-chars", type=int, default=4000)
    recall.add_argument("--no-legacy-bugs", action="store_true")
    recall.add_argument("--read-only", action="store_true",
                        help="只读现有数据库，不创建、迁移或修复索引")
    _add_output_options(recall)

    for name, help_text in (("get", "读取一条知识"), ("archive", "归档一条知识"),
                            ("restore", "恢复一条知识")):
        command = subparsers.add_parser(name, help=help_text)
        command.add_argument("--id", required=True, type=int)
        if name == "get":
            command.add_argument("--read-only", action="store_true")
        _add_output_options(command)

    stats = subparsers.add_parser("stats", help="显示本地知识库统计")
    stats.add_argument("--read-only", action="store_true")
    _add_output_options(stats)

    migrate = subparsers.add_parser("migrate", help="迁移旧版本地知识数据库")
    migrate.add_argument("--source", default=None, help="旧 SQLite 文件路径")
    _add_output_options(migrate)
    return parser


def _query_from_args(args: argparse.Namespace) -> str:
    """按优先级解析 query、--query 和 Base64 query。"""
    if args.query_b64 is not None:
        try:
            return base64.b64decode(args.query_b64, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError) as error:
            raise KnowledgeError("query-b64 must be valid UTF-8 base64") from error
    if args.query_option is not None:
        return args.query_option
    return args.query


def _db_path(args: argparse.Namespace) -> str | None:
    """合并全局和子命令位置的数据库参数。"""
    return args.sub_db or args.db


def _execute(args: argparse.Namespace) -> dict[str, Any]:
    """执行一个已解析命令并返回 JSON 可编码结果。"""
    if args.command == "migrate":
        from bugdb.cli import _migrate_payload

        return _migrate_payload(args.source, _db_path(args))
    base = KnowledgeBase(_db_path(args), read_only=getattr(args, "read_only", False))
    if args.command == "remember":
        return base.remember(
            args.content, kind=args.kind, canonical_key=args.canonical_key,
            title=args.title,
            cues=_csv(args.cues) if args.cues is not None else None,
            tags=_csv(args.tags) if args.tags is not None else None,
            scope_kind=args.scope_kind, scope_key=args.scope_key,
            recall_policy=args.recall_policy, authority=args.authority,
            sensitivity=args.sensitivity,
        )
    if args.command == "recall":
        query = _query_from_args(args)
        return {"query": query, "results": base.recall(
            query, scope_kind=args.scope_kind, scope_key=args.scope_key,
            policy=args.policy, occasion=args.occasion, explicit=args.explicit,
            include_legacy_bugs=not args.no_legacy_bugs,
            limit=args.limit, max_chars=args.max_chars,
        )}
    if args.command == "get":
        return base.get(args.id)
    if args.command == "archive":
        return base.archive(args.id)
    if args.command == "restore":
        return base.restore(args.id)
    if args.command == "stats":
        return base.stats()
    raise KnowledgeError(f"unknown command: {args.command}")


def _safe_error_message(error: Exception) -> str:
    """清理错误文本中的历史产品标记，保持 CLI 中性。"""
    message = str(error) or error.__class__.__name__
    return re.sub(r"bugdb", "local knowledge", message, flags=re.IGNORECASE)


def _print_payload(payload: dict[str, Any], output_format: str) -> None:
    """按 JSON 或简洁文本输出结果。"""
    if output_format == "json":
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return
    if "results" in payload:
        for result in payload["results"]:
            source = result.get("source", "local_knowledge")
            print(f"[{source}] {result.get('title') or result.get('canonical_key', '')}")
            print(result.get("content", ""))
        if not payload["results"]:
            print("没有找到相关知识")
        return
    for key, value in payload.items():
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False, sort_keys=True)
        print(f"{key}: {value}")


def main(argv: list[str] | None = None) -> int:
    """运行命令并返回进程退出码；参数、领域和 SQLite 错误均返回 2。

    Example:
        >>> import contextlib, io
        >>> output = io.StringIO()
        >>> with contextlib.redirect_stdout(output):
        ...     code = main(["--db", ":memory:", "stats", "--format", "json"])
        >>> code
        0
    """
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        output_format = args.sub_format or args.format
        payload = _execute(args)
        _print_payload(payload, output_format)
        return 0
    except (KnowledgeError, ValueError, sqlite3.Error, OSError) as error:
        output_format = "text"
        if "args" in locals():
            output_format = args.sub_format or args.format
        message = _safe_error_message(error)
        if output_format == "json":
            print(json.dumps({"error": {"message": message,
                                          "type": error.__class__.__name__}},
                             ensure_ascii=False, sort_keys=True), file=sys.stderr)
        else:
            print(f"error: {message}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
