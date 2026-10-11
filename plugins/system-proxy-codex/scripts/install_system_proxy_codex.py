#!/usr/bin/env python3
"""Install System Proxy for Codex and complete proxy configuration."""

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
    """Indicate plugin installation or Codex CLI failure."""


class CommandRunner:
    """Run the Codex CLI and parse stable text or JSON output."""

    def __init__(self, *, codex_home: Path | None = None):
        """Resolve the Codex executable and prepare an isolated environment."""

        executable = shutil.which("codex")
        if not executable:
            raise InstallError("codex command not found")
        self.executable = executable
        self.environment = os.environ.copy()
        if codex_home:
            self.environment["CODEX_HOME"] = str(codex_home)

    def run(self, arguments: Sequence[str]) -> str:
        """Run a Codex subcommand and retain actionable failure diagnostics."""

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
            raise InstallError(f"Codex command execution failed: {error}") from error
        if result.returncode != 0:
            diagnostic = (result.stderr or result.stdout).strip()
            raise InstallError(f"codex {' '.join(arguments)} failed: {diagnostic or result.returncode}")
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", result.stdout)

    def json(self, arguments: Sequence[str]) -> dict[str, Any]:
        """Parse JSON output that may contain a Codex terminal prefix."""

        output = self.run(arguments)
        start = output.find("{")
        if start < 0:
            raise InstallError(f"codex {' '.join(arguments)} did not return JSON")
        try:
            value = json.loads(output[start:])
        except json.JSONDecodeError as error:
            raise InstallError(f"Invalid Codex JSON output: {error}") from error
        if not isinstance(value, dict):
            raise InstallError("Codex JSON output must be an object")
        return value


def install_plugin(runner: CommandRunner) -> None:
    """Idempotently add or upgrade the marketplace and refresh the plugin."""

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
    """Print only a redacted proxy configuration summary."""

    print(f"Proxy source: {settings.source}")
    for url in settings.urls():
        print(f"Proxy: {setup_proxy.redact_proxy_url(url)}")


def main(argv: Sequence[str] | None = None) -> int:
    """Install the plugin, merge .env, and enable system proxy support."""

    if sys.version_info < setup_proxy.MIN_PYTHON:
        required = ".".join(str(part) for part in setup_proxy.MIN_PYTHON)
        print(f"Error: Python {required} or later is required", file=sys.stderr)
        return 2
    parser = setup_proxy.build_parser()
    args = parser.parse_args(argv)
    try:
        setup_proxy.validate_arguments(args)
        home = setup_proxy.codex_home_from_env(args.codex_home)
        if args.verbose:
            print(f"Python: {sys.version.split()[0]}")
            print(f"CODEX_HOME: {home}")
            print(f"Platform: {sys.platform}")
        runner = CommandRunner(codex_home=home)
        client = CodexClient([runner.executable], codex_home=home)

        if args.dry_run:
            version = client.version()
            validate_codex_version(version)
            client.feature_enabled("respect_system_proxy")
            print(f"DRY RUN: Codex CLI {version} supports respect_system_proxy")
        elif not args.skip_plugin_install:
            install_plugin(runner)
            print("Installed or refreshed system-proxy-codex.")

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
                print(f"DRY RUN: {'Would update' if result.changed else 'No update needed'} {result.env_path}")
            else:
                print(f"{'Updated' if result.changed else 'No update needed'} {result.env_path}")
                if result.backup_path:
                    print(f"Backup: {result.backup_path}")
                if result.legacy_wss_proxy_present:
                    print("Note: wss_proxy was preserved, but current Codex does not read this nonstandard variable.")

        if not args.dry_run:
            data_dir = home / "plugins" / "data" / "system-proxy-codex"
            feature = ensure_feature(client, data_dir, force=True)
            print("respect_system_proxy enabled." if feature.changed else "respect_system_proxy is already enabled.")
            print("Configuration complete. Fully quit and reopen Codex.")
        return 0
    except (InstallError, SessionStartError, setup_proxy.ProxySetupError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"Error: .env or plugin state file operation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
