"""Create or inspect a legacy BugDB database for the tests, through the bugdb library.

The old bugdb command line used to do this; the plugin no longer ships it.

    legacy_fixture.py DB_FILE add '[{"category": "link", "context": "...", "cause": "...", "content": "..."}]'
    legacy_fixture.py DB_FILE dump
"""

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bugdb.db import BugDB  # noqa: E402
from bugdb.records import new_record  # noqa: E402


def add(path: Path, items: list[dict]) -> list[int]:
    """Save the records and return their ids. An item with "remove": true is deleted again, leaving a gap in the ids."""
    path.parent.mkdir(parents=True, exist_ok=True)
    db = BugDB(path)
    ids = [db.add(new_record(item)).id for item in items]
    removed = [saved for saved, item in zip(ids, items) if item.get("remove")]
    if removed:
        with sqlite3.connect(path) as connection:
            connection.executemany("DELETE FROM knowledge WHERE id = ?", [(saved,) for saved in removed])
    return ids


def dump(path: Path) -> list[list]:
    """Return [id, status] for every record, ordered by id."""
    with sqlite3.connect(path) as connection:
        return [list(row) for row in connection.execute("SELECT id, status FROM knowledge ORDER BY id")]


def main(argv: list[str]) -> int:
    path, command = Path(argv[1]), argv[2]
    result = add(path, json.loads(argv[3])) if command == "add" else dump(path)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
