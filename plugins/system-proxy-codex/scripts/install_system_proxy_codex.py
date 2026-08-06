#!/usr/bin/env python3
"""安装 System Proxy for Codex 并执行完整代理配置。"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Sequence

import setup_proxy
from session_start import CodexClient, SessionStartError, ensure_feature, validate_codex_version


class InstallError(RuntimeError):
    """表示插件安装或 Codex CLI 调用失败。"""


class CommandRunner:
    """执行 Codex CLI 并解析稳定的文本或 JSON 输出。"""

    def __init__(self, *, codex_home: Path | None = None):
        """解析 Codex 可执行文件并准备隔离的环境。"""

        executable = shutil.which("codex")
        if not executable:
            raise InstallError("未找到 codex 命令")
        self.executable = executable
        self.environment = os.environ.copy()
        if codex_home:
            self.environment["CODEX_HOME"] = str(codex_home)

    def run(self, arguments: Sequence[str]) -> str:
        """执行 Codex 子命令，失败时保留可操作诊断。"""

        try:
            result = subprocess.run(
                [self.executable, *arguments],
                check=False,
                capture_output=True,
                text=True,
                timeout=120,
                env=self.environment,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise InstallError(f"Codex 命令执行失败: {error}") from error
        if result.returncode != 0:
            diagnostic = (result.stderr or result.stdout).strip()
            raise InstallError(f"codex {' '.join(arguments)} 失败: {diagnostic or result.returncode}")
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", result.stdout)

    def json(self, arguments: Sequence[str]) -> dict[str, Any]:
        """解析可能带 Codex 终端前缀的 JSON 输出。"""

        output = self.run(arguments)
        start = output.find("{")
        if start < 0:
            raise InstallError(f"codex {' '.join(arguments)} 未返回 JSON")
        try:
            value = json.loads(output[start:])
        except json.JSONDecodeError as error:
            raise InstallError(f"Codex JSON 输出无效: {error}") from error
        if not isinstance(value, dict):
            raise InstallError("Codex JSON 输出必须是对象")
        return value


def install_plugin(runner: CommandRunner) -> None:
    """幂等添加或升级 marketplace，并刷新插件。"""

    listed = runner.json(["plugin", "marketplace", "list", "--json"])
    marketplaces = listed.get("marketplaces", [])
    exists = any(
        isinstance(item, dict) and item.get("name") == setup_proxy.MARKETPLACE_NAME
        for item in marketplaces
    )
    if exists:
        runner.run(["plugin", "marketplace", "upgrade", setup_proxy.MARKETPLACE_NAME])
    else:
        runner.run(["plugin", "marketplace", "add", setup_proxy.MARKETPLACE_URL])
    runner.run(["plugin", "add", setup_proxy.PLUGIN_ID])


def _print_settings(settings: setup_proxy.ProxySettings) -> None:
    """仅输出经过脱敏的代理设置摘要。"""

    print(f"代理来源: {settings.source}")
    for url in settings.urls():
        print(f"代理: {setup_proxy.redact_proxy_url(url)}")


def main(argv: Sequence[str] | None = None) -> int:
    """安装插件、合并 `.env` 并启用系统代理功能。"""

    if sys.version_info < setup_proxy.MIN_PYTHON:
        required = ".".join(str(part) for part in setup_proxy.MIN_PYTHON)
        print(f"错误: 需要 Python {required} 或更高版本", file=sys.stderr)
        return 2
    parser = setup_proxy.build_parser()
    args = parser.parse_args(argv)
    try:
        setup_proxy.validate_arguments(args)
        home = setup_proxy.codex_home_from_env(args.codex_home)
        if args.verbose:
            print(f"Python: {sys.version.split()[0]}")
            print(f"CODEX_HOME: {home}")
            print(f"平台: {sys.platform}")
        runner = CommandRunner(codex_home=home)
        client = CodexClient([runner.executable], codex_home=home)

        if args.dry_run:
            version = client.version()
            validate_codex_version(version)
            client.feature_enabled("respect_system_proxy")
            print(f"DRY RUN: Codex CLI {version} 支持 respect_system_proxy")
        elif not args.skip_plugin_install:
            install_plugin(runner)
            print("已安装或刷新 system-proxy-codex。")

        if not args.config_only:
            settings = setup_proxy.resolve_proxy_settings(
                port=args.port,
                proxy_url=args.proxy_url,
                http_proxy_url=args.http_proxy_url,
                https_proxy_url=args.https_proxy_url,
                all_proxy_url=args.all_proxy_url,
                validate_connection=not args.dry_run,
            )
            result = setup_proxy.merge_env_file(home, settings, dry_run=args.dry_run)
            _print_settings(settings)
            if args.dry_run:
                print(f"DRY RUN: {'将更新' if result.changed else '无需更新'} {result.env_path}")
            else:
                print(f"{'已更新' if result.changed else '无需更新'} {result.env_path}")
                if result.backup_path:
                    print(f"备份: {result.backup_path}")
                if result.legacy_wss_proxy_present:
                    print("提示: 已保留 wss_proxy，但当前 Codex 不读取该非标准变量。")

        if not args.dry_run:
            data_dir = home / "plugins" / "data" / "system-proxy-codex"
            feature = ensure_feature(client, data_dir, force=True)
            print("respect_system_proxy 已启用。" if feature.changed else "respect_system_proxy 已处于启用状态。")
            print("配置完成。请完整退出并重新打开 Codex。")
        return 0
    except (InstallError, SessionStartError, setup_proxy.ProxySetupError) as error:
        print(f"错误: {error}", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"错误: .env 或插件状态文件操作失败: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
