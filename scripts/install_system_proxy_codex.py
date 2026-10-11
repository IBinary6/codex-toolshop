#!/usr/bin/env python3
"""Download and run the versioned Python installer for System Proxy for Codex."""

from __future__ import annotations

import hashlib
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


RELEASE_REF = "system-proxy-codex-v0.1.4"
RAW_ROOT = (
    "https://raw.githubusercontent.com/IBinary6/codex-toolshop/"
    f"{RELEASE_REF}/plugins/system-proxy-codex/scripts"
)
FILES = ("setup_proxy.py", "session_start.py", "install_system_proxy_codex.py")
EXPECTED_SHA256 = {
    "setup_proxy.py": "13bb6f2dece2266f6c90a3a230d41a2602cd6f7c0d7221c7f3e5a185db0fd7d7",
    "session_start.py": "420e6c289a218139c168f2f5fe2f10d95d26e0ce2691544d3334ed49acbebf0c",
    "install_system_proxy_codex.py": "51d8b447f2a5ef86763f700573dab612aac565e1345931d2dc7cc2d12b9ee080",
}


def main() -> int:
    """Download the installer to a temporary directory and run it with the current Python."""

    if sys.version_info < (3, 10):
        print("Error: Python 3.10 or later is required", file=sys.stderr)
        return 2
    script_file = globals().get("__file__")
    local_scripts = (
        Path(script_file).resolve().parents[1] / "plugins" / "system-proxy-codex" / "scripts"
        if script_file
        else None
    )
    if local_scripts and all((local_scripts / name).is_file() for name in FILES):
        result = subprocess.run(
            [sys.executable, str(local_scripts / "install_system_proxy_codex.py"), *sys.argv[1:]]
        )
        return result.returncode
    with tempfile.TemporaryDirectory(prefix="system-proxy-codex-") as temp:
        root = Path(temp)
        try:
            for name in FILES:
                with urllib.request.urlopen(f"{RAW_ROOT}/{name}", timeout=30) as response:
                    content = response.read()
                digest = hashlib.sha256(content).hexdigest()
                if digest != EXPECTED_SHA256[name]:
                    print(f"Error: {name} failed SHA-256 verification", file=sys.stderr)
                    return 2
                root.joinpath(name).write_bytes(content)
        except (OSError, urllib.error.URLError) as error:
            print(f"Error: cannot download installer components: {error}", file=sys.stderr)
            return 2
        result = subprocess.run([sys.executable, str(root / "install_system_proxy_codex.py"), *sys.argv[1:]])
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
