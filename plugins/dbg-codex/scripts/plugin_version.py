"""Read the runtime version from the plugin manifest."""

import json
from pathlib import Path


def current_version() -> str:
    manifest = Path(__file__).resolve().parents[1] / ".codex-plugin" / "plugin.json"
    version = json.loads(manifest.read_text(encoding="utf-8"))["version"]
    if not isinstance(version, str) or not version:
        raise ValueError("Dbg plugin manifest lacks a valid version")
    return version
