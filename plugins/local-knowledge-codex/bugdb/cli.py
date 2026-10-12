"""Codex BugDB CLI.

All skills, commands, and hooks access the SQLite core through this entry point. JSON is the default output;
``--format text`` is for human reading; ``migrate`` reads external Claude databases only.
"""

import argparse
import base64
import json
import sqlite3
import sys
from pathlib import Path

_PACKAGE_PARENT = str(Path(__file__).resolve().parent.parent)
if _PACKAGE_PARENT not in sys.path:
    sys.path.insert(0, _PACKAGE_PARENT)

from bugdb import formatters, migration, normalizer, records, search as search_mod  # noqa: E402
from bugdb import paths, utils  # noqa: E402
from bugdb.db import BugDB  # noqa: E402
from bugdb.exceptions import BugDBError, RecordNotFound  # noqa: E402
from bugdb.models import EntryKind, Status  # noqa: E402


def _print(value: str) -> None:
    """Output text with a trailing newline."""
    sys.stdout.write(value)
    if not value.endswith("\n"):
        sys.stdout.write("\n")


def _output(value, kind: str, fmt: str) -> None:
    """Select JSON or text formatting based on result type."""
    if fmt == "text":
        if kind == "results":
            _print(formatters.results_to_text(value))
        elif kind == "record":
            _print(formatters.record_to_text(value))
        else:
            _print(formatters.stats_to_text(value))
        return
    if kind == "results":
        _print(formatters.results_to_json(value))
    elif kind == "record":
        _print(formatters.record_to_json(value))
    else:
        _print(formatters.stats_to_json(value))


def _search(args, db: BugDB) -> int:
    """Run exact search with full-text fallback."""
    query = args.query
    if args.query_b64:
        query = base64.b64decode(args.query_b64).decode("utf-8", errors="replace")
    results = search_mod.search(db, query, args.language,
                                args.include_deprecated, args.limit)
    fallback = []
    if not results and not args.no_fallback:
        fallback = search_mod.fallback_neighborhood(db, query, args.language, 5)
    if args.format == "text":
        _print(formatters.search_results_to_text(results, fallback or None))
    else:
        _print(formatters.search_results_to_json(results, fallback or None))
    return 0


def _explore(args, db: BugDB) -> int:
    """Run a broad exploratory search."""
    tags = utils.comma_split(args.tags) if args.tags else None
    filters = {"language": args.language, "category": args.category,
               "entry_kind": args.entry_kind, "tags": tags}
    results = search_mod.explore(db, args.query, args.language, args.category,
                                 args.entry_kind, tags, args.limit)
    if args.format == "text":
        _print(formatters.explore_to_text(results, args.query, filters))
    else:
        _print(formatters.explore_to_json(results, args.query, filters))
    return 0


def _add(args, db: BugDB) -> int:
    """Add a new knowledge record."""
    record = records.new_record({
        "entry_kind": args.entry_kind, "category": args.category,
        "key_pattern": args.key_pattern, "context": args.context,
        "cause": args.cause, "content": args.content,
        "action_steps": records.parse_steps(args.action_steps), "title": args.title,
        "language": args.language, "project_type": args.project_type,
        "tags": args.tags, "confidence": args.confidence, "valid_for": args.valid_for,
    })
    _output(db.add(record), "record", args.format)
    return 0


def _update(args, db: BugDB) -> int:
    """Update only record fields explicitly supplied by the user."""
    record = db.get(args.id)
    for name in ("content", "cause", "tags", "valid_for", "language", "project_type", "title"):
        value = getattr(args, name)
        if value is not None:
            setattr(record, name, utils.comma_split(value) if name == "tags" else value)
    if args.action_steps is not None:
        record.action_steps = records.parse_steps(args.action_steps)
    if args.confidence is not None:
        record.confidence = args.confidence
    _output(db.update(record), "record", args.format)
    return 0


def _import(args, db: BugDB) -> int:
    """Import BugDB from a JSON export."""
    imported = migration.import_records(migration.load_payload(Path(args.input)), db, deduplicate=args.deduplicate)
    _output({"imported": imported, "path": args.input}, "stats", args.format)
    return 0


def _migrate(args) -> int:
    """Migrate a legacy SQLite database to the tool-neutral shared directory."""
    _output(migration.migrate(args.source), "stats", args.format)
    return 0


def _config(args) -> int:
    """Read or set BugDB configuration."""
    action = args.config_action
    config_file = paths.get_config_file()
    if action == "path":
        _output({"db_path": str(paths.get_db_path()), "log_path": str(paths.get_log_path()),
                 "bugdb_home": str(paths.get_bugdb_home()), "config_file": str(config_file)},
                "stats", args.format)
        return 0
    if action == "init":
        config_file.parent.mkdir(parents=True, exist_ok=True)
        if not config_file.exists():
            config_file.write_text("{}\n", encoding="utf-8")
        _output({"created": True, "path": str(config_file)}, "stats", args.format)
        return 0
    if args.key is None:
        raise ValueError(f"config {action} requires key")
    config = paths.read_config().copy()
    if action == "get":
        _output({args.key: config.get(args.key)}, "stats", args.format)
        return 0
    if args.value is None:
        raise ValueError("config set requires value")
    config[args.key] = args.value
    config_file.parent.mkdir(parents=True, exist_ok=True)
    config_file.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    paths._clear_config_cache()
    _output({"updated": args.key, "value": args.value}, "stats", args.format)
    return 0


def _parser() -> argparse.ArgumentParser:
    """Build the complete CLI argument parser."""
    parser = argparse.ArgumentParser(prog="bugdb-codex", description="Codex BugDB CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(command):
        command.add_argument("--format", choices=("json", "text"), default="json")

    command = sub.add_parser("search", help="Search knowledge records")
    command.add_argument("--query", default="")
    command.add_argument("--query-b64", default=None)
    command.add_argument("--language", default=None)
    command.add_argument("--include-deprecated", action="store_true")
    command.add_argument("--limit", type=int, default=3)
    command.add_argument("--no-fallback", action="store_true")
    common(command)

    command = sub.add_parser("explore", help="Explore with free-text search")
    command.add_argument("--query", default="")
    command.add_argument("--language", default=None)
    command.add_argument("--category", default=None)
    command.add_argument("--entry-kind", default=None)
    command.add_argument("--tags", default=None)
    command.add_argument("--limit", type=int, default=20)
    common(command)

    command = sub.add_parser("get", help="Get by ID")
    command.add_argument("--id", type=int, required=True)
    common(command)

    command = sub.add_parser("list", help="List records")
    command.add_argument("--status", choices=("active", "deprecated", "obsolete", "archived", "all"), default="active")
    command.add_argument("--language", default=None)
    common(command)

    command = sub.add_parser("stats", help="Statistics")
    common(command)

    command = sub.add_parser("add", help="Save a new record")
    command.add_argument("--entry-kind", choices=[item.value for item in EntryKind], default="bug")
    command.add_argument("--category", required=True)
    command.add_argument("--key-pattern", default=None)
    command.add_argument("--context", default="")
    command.add_argument("--cause", required=True)
    command.add_argument("--content", required=True)
    command.add_argument("--action-steps", default="[]")
    command.add_argument("--title", default="")
    command.add_argument("--language", default="any")
    command.add_argument("--project-type", default="any")
    command.add_argument("--tags", default="")
    command.add_argument("--confidence", type=int, default=100)
    command.add_argument("--valid-for", default=None)
    common(command)

    command = sub.add_parser("update", help="Update a record")
    command.add_argument("--id", type=int, required=True)
    for name in ("content", "cause", "tags", "valid-for", "language", "project-type", "title"):
        command.add_argument(f"--{name}", dest=name.replace("-", "_"), default=None)
    command.add_argument("--action-steps", default=None)
    command.add_argument("--confidence", type=int, default=None)
    common(command)

    command = sub.add_parser("delete", help="Soft-delete or permanently delete")
    command.add_argument("--id", type=int, required=True)
    command.add_argument("--hard", action="store_true")
    common(command)

    command = sub.add_parser("restore", help="Restore an archived record")
    command.add_argument("--id", type=int, required=True)
    common(command)

    command = sub.add_parser("feedback", help="Give fix feedback")
    command.add_argument("--id", type=int, required=True)
    command.add_argument("--result", choices=("success", "failure"), required=True)
    common(command)

    command = sub.add_parser("deprecate", help="Mark deprecated")
    command.add_argument("--id", type=int, required=True)
    command.add_argument("--replace-with", type=int, default=None)
    command.add_argument("--reason", default=None)
    common(command)

    command = sub.add_parser("obsolete", help="Mark obsolete")
    command.add_argument("--id", type=int, required=True)
    command.add_argument("--reason", default=None)
    common(command)

    command = sub.add_parser("find-similar", help="Check duplicates before adding")
    command.add_argument("--pattern", required=True)
    command.add_argument("--threshold", type=float, default=0.7)
    command.add_argument("--limit", type=int, default=5)
    common(command)

    command = sub.add_parser("normalize", help="Normalize error text")
    command.add_argument("--input", required=True)
    common(command)

    command = sub.add_parser("export", help="Export all records")
    command.add_argument("--output", required=True)
    common(command)

    command = sub.add_parser("import", help="Import JSON records")
    command.add_argument("--input", required=True)
    command.add_argument("--deduplicate", action="store_true")
    common(command)

    command = sub.add_parser("migrate", help="Migrate read-only from Claude SQLite")
    command.add_argument("--source", default=None)
    common(command)

    command = sub.add_parser("config", help="Configuration path")
    command.add_argument("config_action", choices=("path", "get", "set", "init"))
    command.add_argument("key", nargs="?", default=None)
    command.add_argument("value", nargs="?", default=None)
    common(command)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the CLI and convert domain errors to stable exit codes."""
    args = _parser().parse_args(argv)
    try:
        if args.command == "config":
            return _config(args)
        if args.command == "migrate":
            return _migrate(args)
        db = BugDB()
        if args.command == "search":
            return _search(args, db)
        if args.command == "explore":
            return _explore(args, db)
        if args.command == "add":
            return _add(args, db)
        if args.command == "update":
            return _update(args, db)
        if args.command == "get":
            _output(db.get(args.id), "record", args.format)
            return 0
        if args.command == "list":
            _output(db.list_all(args.status, args.language), "results", args.format)
            return 0
        if args.command == "stats":
            _output(db.stats(), "stats", args.format)
            return 0
        if args.command == "delete":
            db.delete(args.id, args.hard)
            _output({"deleted": args.id, "hard": args.hard}, "stats", args.format)
            return 0
        if args.command == "restore":
            _output(db.restore(args.id), "record", args.format)
            return 0
        if args.command == "feedback":
            _output(db.feedback(args.id, args.result == "success"), "record", args.format)
            return 0
        if args.command in ("deprecate", "obsolete"):
            record = db.get(args.id)
            record.status = Status.DEPRECATED if args.command == "deprecate" else Status.OBSOLETE
            if args.command == "deprecate" and args.replace_with is not None:
                record.replaced_by_id = args.replace_with
            if args.reason:
                record.deprecation_note = args.reason
            _output(db.update(record), "record", args.format)
            return 0
        if args.command == "find-similar":
            _output(search_mod.find_similar(db, args.pattern, args.threshold, args.limit), "results", args.format)
            return 0
        if args.command == "normalize":
            normalized = normalizer.normalize(args.input)
            output = {"normalized": normalized, "keywords": normalizer.extract_keywords(normalized)}
            _output(output, "stats", args.format)
            return 0
        if args.command == "export":
            records = db.list_all(status="all")
            Path(args.output).write_text(json.dumps({"version": 2,
                "records": [formatters.record_to_dict(item) for item in records]},
                ensure_ascii=False, indent=2), encoding="utf-8")
            _output({"exported": len(records), "path": args.output}, "stats", args.format)
            return 0
        if args.command == "import":
            return _import(args, db)
        raise ValueError(f"unknown command: {args.command}")
    except RecordNotFound as error:
        sys.stderr.write(f"error: {error}\n")
        return 2
    except (BugDBError, ValueError, OSError, json.JSONDecodeError, sqlite3.Error) as error:
        sys.stderr.write(f"bugdb error: {error}\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
