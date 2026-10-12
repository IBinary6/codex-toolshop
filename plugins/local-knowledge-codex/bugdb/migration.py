"""Import and migrate BugDB knowledge between databases.

Both command line tools call this module, so the migration logic does not live in either CLI.
"""

import json
import os
import sqlite3
import tempfile
from pathlib import Path

from bugdb import paths
from bugdb.db import BugDB
from bugdb.records import new_record


def load_payload(path: Path) -> list[dict]:
    """Read Claude v1/v2 export format and validate the records array."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
        raise ValueError("payload must be an object containing records list")
    if any(not isinstance(item, dict) for item in payload["records"]):
        raise ValueError("records must contain objects")
    return payload["records"]


def import_records(records: list[dict], db: BugDB, *, deduplicate: bool = False) -> int:
    """Validate all records before writing; optionally deduplicate idempotently by pattern/context."""
    pending = [new_record(item) for item in records]
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


def external_records(source: Path) -> list[dict]:
    """Open Claude SQLite read-only, supporting v1 ``bugs`` and v3 ``knowledge`` tables."""
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


def copy_database(source: Path, target: Path) -> int:
    """Copy the entire legacy database losslessly with SQLite backup and publish it atomically to the shared path."""
    records = external_records(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        prefix=f".{target.name}.migrating-", suffix=".tmp",
        dir=target.parent, delete=False,
    )
    temporary = Path(handle.name)
    handle.close()
    source_connection = None
    target_connection = None
    try:
        source_uri = f"{source.resolve().as_uri()}?mode=ro"
        source_connection = sqlite3.connect(source_uri, uri=True)
        target_connection = sqlite3.connect(str(temporary))
        source_connection.backup(target_connection)
        target_connection.close()
        target_connection = None
        source_connection.close()
        source_connection = None
        if target.exists():
            temporary.unlink(missing_ok=True)
            return -1
        os.replace(temporary, target)
        return len(records)
    finally:
        if target_connection is not None:
            target_connection.close()
        if source_connection is not None:
            source_connection.close()
        temporary.unlink(missing_ok=True)


def migrate(source: str | Path | None = None,
                     target: str | Path | None = None) -> dict:
    """Perform compatibility migration and return structured results without choosing an output format."""
    source = Path(source).expanduser() if source else paths.get_legacy_claude_db_path()
    target = paths.get_db_path(target)
    if source.resolve() == target.resolve():
        return {"migrated": 0, "source": str(source), "target": str(target), "shared": True}
    if not target.exists():
        copied = copy_database(source, target)
        if copied >= 0:
            BugDB(target)
            return {"migrated": copied, "source": str(source), "target": str(target),
                    "shared": False, "copied": True}
    db = BugDB(target)
    imported = import_records(external_records(source), db, deduplicate=True)
    return {"migrated": imported, "source": str(source), "target": str(target),
            "shared": False, "copied": False}
