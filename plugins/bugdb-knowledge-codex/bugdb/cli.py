"""Codex BugDB CLI。

所有 skill、command 和 hook 都通过本入口访问 SQLite 核心。默认 JSON 输出，
``--format text`` 用于人工阅读；``migrate`` 对外部 Claude 数据库只读。
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

from bugdb import formatters, normalizer, search as search_mod  # noqa: E402
from bugdb import paths, utils  # noqa: E402
from bugdb.db import BugDB  # noqa: E402
from bugdb.exceptions import BugDBError, RecordNotFound  # noqa: E402
from bugdb.models import (  # noqa: E402
    Category,
    EntryKind,
    KnowledgeRecord,
    Status,
    validate_kind_category,
)


def _print(value: str) -> None:
    """输出带尾换行的文本。"""
    sys.stdout.write(value)
    if not value.endswith("\n"):
        sys.stdout.write("\n")


def _output(value, kind: str, fmt: str) -> None:
    """根据结果类型选择 JSON 或文本格式化。"""
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
    """执行精确/全文回退搜索。"""
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
    """执行宽松联想搜索。"""
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


def _parse_steps(raw: str | None) -> list:
    """解析 action_steps JSON 数组，非法输入抛出 ValueError。"""
    if raw is None or not str(raw).strip():
        return []
    value = utils.safe_json_loads(raw)
    if not isinstance(value, list):
        raise ValueError("--action-steps must be a JSON array")
    return value


def _new_record(data: dict) -> KnowledgeRecord:
    """把 CLI 或导入字典转换为已验证的记录模型。"""
    kind = EntryKind(data.get("entry_kind", "bug"))
    category = Category(data.get("category") or data.get("error_type", "compile"))
    error = validate_kind_category(kind, category)
    if error:
        raise ValueError(error)
    context = data.get("context") or data.get("error_message", "")
    pattern = data.get("key_pattern") or data.get("error_pattern")
    if not pattern:
        pattern = normalizer.extract_keywords(normalizer.normalize(context))
    if not pattern:
        raise ValueError("key_pattern is empty (provide context or key_pattern)")
    action_steps = data.get("action_steps")
    if action_steps is None:
        action_steps = data.get("solution_steps", [])
    if isinstance(action_steps, str):
        action_steps = _parse_steps(action_steps)
    if not isinstance(action_steps, list):
        raise ValueError("action_steps must be a JSON array")
    tags = data.get("tags", [])
    if isinstance(tags, str):
        tags = utils.comma_split(tags)
    return KnowledgeRecord(
        id=data.get("id"), entry_kind=kind, category=category,
        key_pattern=str(pattern), context=context,
        cause=data.get("cause") or data.get("root_cause", ""),
        content=data.get("content") or data.get("solution", ""),
        action_steps=list(action_steps), title=data.get("title", ""),
        language=data.get("language", "any"), project_type=data.get("project_type", "any"),
        tags=list(tags), confidence=int(data.get("confidence", 100)),
        usage_count=int(data.get("usage_count", 0)),
        success_count=int(data.get("success_count", 0)),
        status=Status(data.get("status", "active")),
        replaced_by_id=data.get("replaced_by_id") or data.get("replaces_id"),
        valid_for=data.get("valid_for"), deprecation_note=data.get("deprecation_note"),
        consecutive_failures=int(data.get("consecutive_failures", 0)),
        created_at=data.get("created_at", ""), updated_at=data.get("updated_at", ""),
    )


def _add(args, db: BugDB) -> int:
    """录入新知识。"""
    record = _new_record({
        "entry_kind": args.entry_kind, "category": args.category,
        "key_pattern": args.key_pattern, "context": args.context,
        "cause": args.cause, "content": args.content,
        "action_steps": _parse_steps(args.action_steps), "title": args.title,
        "language": args.language, "project_type": args.project_type,
        "tags": args.tags, "confidence": args.confidence, "valid_for": args.valid_for,
    })
    _output(db.add(record), "record", args.format)
    return 0


def _update(args, db: BugDB) -> int:
    """只更新用户显式提供的记录字段。"""
    record = db.get(args.id)
    for name in ("content", "cause", "tags", "valid_for", "language", "project_type", "title"):
        value = getattr(args, name)
        if value is not None:
            setattr(record, name, utils.comma_split(value) if name == "tags" else value)
    if args.action_steps is not None:
        record.action_steps = _parse_steps(args.action_steps)
    if args.confidence is not None:
        record.confidence = args.confidence
    _output(db.update(record), "record", args.format)
    return 0


def _load_payload(path: Path) -> list[dict]:
    """读取 Claude v1/v2 导出格式并校验 records 数组。"""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
        raise ValueError("payload must be an object containing records list")
    if any(not isinstance(item, dict) for item in payload["records"]):
        raise ValueError("records must contain objects")
    return payload["records"]


def _import_records(records: list[dict], db: BugDB, *, deduplicate: bool = False) -> int:
    """先全量校验，再写入记录；可按 pattern/context 幂等去重。"""
    pending = [_new_record(item) for item in records]
    existing = {(item.key_pattern, item.context) for item in db.list_all(status="all")}
    imported = 0
    for record in pending:
        key = (record.key_pattern, record.context)
        if deduplicate and key in existing:
            continue
        db.add(record)
        existing.add(key)
        imported += 1
    return imported


def _import(args, db: BugDB) -> int:
    """从 JSON 导出文件导入 BugDB。"""
    imported = _import_records(_load_payload(Path(args.input)), db, deduplicate=args.deduplicate)
    _output({"imported": imported, "path": args.input}, "stats", args.format)
    return 0


def _external_records(source: Path) -> list[dict]:
    """只读打开 Claude SQLite，兼容 v1 ``bugs`` 与 v3 ``knowledge`` 表。"""
    if not source.exists():
        raise ValueError(f"source database does not exist: {source}")
    uri = f"{source.resolve().as_uri()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "knowledge" in tables:
            rows = conn.execute("SELECT * FROM knowledge").fetchall()
            result = []
            for row in rows:
                result.append(dict(row))
            return result
        if "bugs" in tables:
            rows = conn.execute("SELECT * FROM bugs").fetchall()
            return [dict(row) for row in rows]
        raise ValueError("source database has no knowledge or bugs table")
    finally:
        conn.close()


def _migrate(args, db: BugDB) -> int:
    """从独立 Claude 数据库只读迁移；默认路径已与 Claude 共享。"""
    source = Path(args.source).expanduser() if args.source else paths.get_legacy_claude_db_path()
    if source.resolve() == db.path.resolve():
        _output({"migrated": 0, "source": str(source), "target": str(db.path), "shared": True},
                "stats", args.format)
        return 0
    imported = _import_records(_external_records(source), db, deduplicate=True)
    _output({"migrated": imported, "source": str(source), "target": str(db.path), "shared": False},
            "stats", args.format)
    return 0


def _config(args) -> int:
    """查看或设置 BugDB 配置。"""
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
    """构建完整 CLI 参数解析器。"""
    parser = argparse.ArgumentParser(prog="bugdb-codex", description="Codex BugDB CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(command):
        command.add_argument("--format", choices=("json", "text"), default="json")

    command = sub.add_parser("search", help="搜索知识记录")
    command.add_argument("--query", default="")
    command.add_argument("--query-b64", default=None)
    command.add_argument("--language", default=None)
    command.add_argument("--include-deprecated", action="store_true")
    command.add_argument("--limit", type=int, default=3)
    command.add_argument("--no-fallback", action="store_true")
    common(command)

    command = sub.add_parser("explore", help="自由文本联想搜索")
    command.add_argument("--query", default="")
    command.add_argument("--language", default=None)
    command.add_argument("--category", default=None)
    command.add_argument("--entry-kind", default=None)
    command.add_argument("--tags", default=None)
    command.add_argument("--limit", type=int, default=20)
    common(command)

    command = sub.add_parser("get", help="按 ID 查询")
    command.add_argument("--id", type=int, required=True)
    common(command)

    command = sub.add_parser("list", help="列出记录")
    command.add_argument("--status", choices=("active", "deprecated", "obsolete", "archived", "all"), default="active")
    command.add_argument("--language", default=None)
    common(command)

    command = sub.add_parser("stats", help="统计信息")
    common(command)

    command = sub.add_parser("add", help="保存新记录")
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

    command = sub.add_parser("update", help="更新记录")
    command.add_argument("--id", type=int, required=True)
    for name in ("content", "cause", "tags", "valid-for", "language", "project-type", "title"):
        command.add_argument(f"--{name}", dest=name.replace("-", "_"), default=None)
    command.add_argument("--action-steps", default=None)
    command.add_argument("--confidence", type=int, default=None)
    common(command)

    command = sub.add_parser("delete", help="软删除或物理删除")
    command.add_argument("--id", type=int, required=True)
    command.add_argument("--hard", action="store_true")
    common(command)

    command = sub.add_parser("restore", help="恢复归档记录")
    command.add_argument("--id", type=int, required=True)
    common(command)

    command = sub.add_parser("feedback", help="反馈方案有效性")
    command.add_argument("--id", type=int, required=True)
    command.add_argument("--result", choices=("success", "failure"), required=True)
    common(command)

    command = sub.add_parser("deprecate", help="标记废弃")
    command.add_argument("--id", type=int, required=True)
    command.add_argument("--replace-with", type=int, default=None)
    command.add_argument("--reason", default=None)
    common(command)

    command = sub.add_parser("obsolete", help="标记不可用")
    command.add_argument("--id", type=int, required=True)
    command.add_argument("--reason", default=None)
    common(command)

    command = sub.add_parser("find-similar", help="录入前去重")
    command.add_argument("--pattern", required=True)
    command.add_argument("--threshold", type=float, default=0.7)
    command.add_argument("--limit", type=int, default=5)
    common(command)

    command = sub.add_parser("normalize", help="归一化错误文本")
    command.add_argument("--input", required=True)
    common(command)

    command = sub.add_parser("export", help="导出全部记录")
    command.add_argument("--output", required=True)
    common(command)

    command = sub.add_parser("import", help="导入 JSON 记录")
    command.add_argument("--input", required=True)
    command.add_argument("--deduplicate", action="store_true")
    common(command)

    command = sub.add_parser("migrate", help="从 Claude SQLite 只读迁移")
    command.add_argument("--source", default=None)
    common(command)

    command = sub.add_parser("config", help="配置路径")
    command.add_argument("config_action", choices=("path", "get", "set", "init"))
    command.add_argument("key", nargs="?", default=None)
    command.add_argument("value", nargs="?", default=None)
    common(command)
    return parser


def main(argv: list[str] | None = None) -> int:
    """执行 CLI 并将领域错误转换成稳定退出码。"""
    args = _parser().parse_args(argv)
    try:
        if args.command == "config":
            return _config(args)
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
        if args.command == "migrate":
            return _migrate(args, db)
        raise ValueError(f"unknown command: {args.command}")
    except RecordNotFound as error:
        sys.stderr.write(f"error: {error}\n")
        return 2
    except (BugDBError, ValueError, OSError, json.JSONDecodeError, sqlite3.Error) as error:
        sys.stderr.write(f"bugdb error: {error}\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
