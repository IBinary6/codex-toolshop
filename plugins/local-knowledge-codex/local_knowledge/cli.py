"""Local Knowledge command-line entry point.

This entry point supports direct ``python local_knowledge/cli.py`` execution and use as the
``local_knowledge.cli`` module. Output is concise by default; ``--format json``
is intended for hooks and automation.
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
    # Add the plugin root to the import path for direct script execution, matching the console script.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from local_knowledge.errors import KnowledgeError
from local_knowledge.storage import KnowledgeBase


def _csv(value: str | None) -> list[str]:
    """Parse comma-separated CLI cues and tags."""
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _add_output_options(parser: argparse.ArgumentParser) -> None:
    """Register output options in both global and subcommand positions for common invocation orders."""
    parser.add_argument("--format", dest="sub_format", choices=("json", "text"),
                        default=None, help="Output format")
    parser.add_argument("--db", dest="sub_db", default=None, help="SQLite file path")


def build_parser() -> argparse.ArgumentParser:
    """Create the Local Knowledge CLI argument parser.

    Example:
        >>> build_parser().prog
        'knowledge-codex'
    """
    parser = argparse.ArgumentParser(prog="knowledge-codex",
                                     description="Save and recall local knowledge")
    parser.add_argument("--db", default=None, help="SQLite file path")
    parser.add_argument("--format", choices=("json", "text"), default="text",
                        help="Output format")
    subparsers = parser.add_subparsers(dest="command", required=True)

    remember = subparsers.add_parser("remember", help="Explicitly save one knowledge item")
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

    recall = subparsers.add_parser("recall", help="Recall related knowledge by cues")
    recall.add_argument("query", nargs="?", default="")
    recall.add_argument("--query", dest="query_option", default=None)
    recall.add_argument("--query-b64", default=None)
    recall.add_argument("--kind", default=None,
                        choices=("bug", "preference", "fact", "note", "decision", "workflow"),
                        help="Filter knowledge kind before limiting candidates; omit to query all kinds")
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
                        help="Read the existing database without creating, migrating, or repairing indexes")
    _add_output_options(recall)

    for name, help_text in (("get", "Read one knowledge item"), ("archive", "Archive one knowledge item"),
                            ("restore", "Restore one knowledge item")):
        command = subparsers.add_parser(name, help=help_text)
        command.add_argument("--id", required=True, type=int)
        if name == "get":
            command.add_argument("--read-only", action="store_true")
        _add_output_options(command)

    stats = subparsers.add_parser("stats", help="Show local knowledge statistics")
    stats.add_argument("--read-only", action="store_true")
    _add_output_options(stats)

    migrate = subparsers.add_parser("migrate", help="Migrate a legacy local knowledge database")
    migrate.add_argument("--source", default=None, help="Legacy SQLite file path")
    _add_output_options(migrate)
    return parser


def _query_from_args(args: argparse.Namespace) -> str:
    """Resolve query, --query, and Base64 query by precedence."""
    if args.query_b64 is not None:
        try:
            return base64.b64decode(args.query_b64, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError) as error:
            raise KnowledgeError("query-b64 must be valid UTF-8 base64") from error
    if args.query_option is not None:
        return args.query_option
    return args.query


def _db_path(args: argparse.Namespace) -> str | None:
    """Merge database options from global and subcommand positions."""
    return args.sub_db or args.db


def _execute(args: argparse.Namespace) -> dict[str, Any]:
    """Execute a parsed command and return a JSON-encodable result."""
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
            limit=args.limit, max_chars=args.max_chars, kind=args.kind,
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
    """Remove legacy product markers from error text to keep the CLI neutral."""
    message = str(error) or error.__class__.__name__
    return re.sub(r"bugdb", "local knowledge", message, flags=re.IGNORECASE)


def _print_payload(payload: dict[str, Any], output_format: str) -> None:
    """Output a result as JSON or concise text."""
    if output_format == "json":
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return
    if "results" in payload:
        for result in payload["results"]:
            source = result.get("source", "local_knowledge")
            print(f"[{source}] {result.get('title') or result.get('canonical_key', '')}")
            print(result.get("content", ""))
        if not payload["results"]:
            print("No related knowledge found")
        return
    for key, value in payload.items():
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False, sort_keys=True)
        print(f"{key}: {value}")


def main(argv: list[str] | None = None) -> int:
    """Run a command and return its process exit code; argument, domain, and SQLite errors return 2.

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
