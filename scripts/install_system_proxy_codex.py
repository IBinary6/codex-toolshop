#!/usr/bin/env python3
"""下载并运行 System Proxy for Codex 的版本化 Python 安装器。"""

from __future__ import annotations

import hashlib
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


RELEASE_REF = "system-proxy-codex-v0.1.2"
RAW_ROOT = (
    "https://raw.githubusercontent.com/IBinary6/codex-toolshop/"
    f"{RELEASE_REF}/plugins/system-proxy-codex/scripts"
)
FILES = ("setup_proxy.py", "session_start.py", "install_system_proxy_codex.py")
EXPECTED_SHA256 = {
    "setup_proxy.py": "a5764607489de3e0fc93619441b295e2a25e80eec88f12e0dd2d3e04b5f63a7f",
    "session_start.py": "56dbe18174df0749803ec98bd2bbe65dfe059b85c27fe1f74661401560fbfe81",
    "install_system_proxy_codex.py": "1fb833b80bae57294fbd2629c8739a1a8ddd62b7b6f9655ce5ab0d05f2f2b017",
}


def main() -> int:
    """把安装器下载到临时目录并使用当前 Python 执行。"""

    if sys.version_info < (3, 10):
        print("错误: 需要 Python 3.10 或更高版本", file=sys.stderr)
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
                    print(f"错误: {name} 的 SHA-256 校验失败", file=sys.stderr)
                    return 2
                root.joinpath(name).write_bytes(content)
        except (OSError, urllib.error.URLError) as error:
            print(f"错误: 无法下载安装器组件: {error}", file=sys.stderr)
            return 2
        result = subprocess.run([sys.executable, str(root / "install_system_proxy_codex.py"), *sys.argv[1:]])
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
