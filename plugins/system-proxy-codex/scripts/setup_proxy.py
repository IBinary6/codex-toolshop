#!/usr/bin/env python3
"""Configure the Codex proxy environment and system proxy support."""

from __future__ import annotations

import argparse
import ast
import configparser
import dataclasses
import datetime as dt
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path
from typing import Iterable, Mapping, Sequence


DEFAULT_PROXY_URL = "http://127.0.0.1:7897"
DEFAULT_NO_PROXY = ("localhost", "127.0.0.1", "::1")
MANAGED_KEYS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")
MIN_PYTHON = (3, 10)
MIN_CODEX_VERSION = (0, 146, 1)
MARKETPLACE_NAME = "codex-toolshop"
MARKETPLACE_URL = "https://github.com/IBinary6/codex-toolshop.git"
PLUGIN_ID = "system-proxy-codex@codex-toolshop"


class ProxySetupError(RuntimeError):
    """Indicate that proxy setup cannot be completed safely."""


@dataclasses.dataclass(frozen=True)
class ProxySettings:
    """Describe proxy addresses to write to the Codex environment."""

    http: str | None
    https: str | None
    all_proxy: str | None
    no_proxy: tuple[str, ...] = DEFAULT_NO_PROXY
    source: str = "unknown"

    @classmethod
    def uniform(cls, url: str, *, source: str) -> "ProxySettings":
        """Create HTTP, HTTPS, and general proxy settings with one address."""

        normalized = normalize_proxy_url(url)
        return cls(normalized, normalized, normalized, source=source)

    def urls(self) -> tuple[str, ...]:
        """Return unique nonempty proxy addresses."""

        return tuple(dict.fromkeys(value for value in (self.http, self.https, self.all_proxy) if value))


@dataclasses.dataclass(frozen=True)
class EnvMergeResult:
    """Describe the result of an .env merge."""

    changed: bool
    env_path: Path
    backup_path: Path | None
    legacy_wss_proxy_present: bool


def normalize_proxy_url(value: str) -> str:
    """Validate and normalize an HTTP(S) proxy URL."""

    raw = value.strip().strip('"').strip("'")
    if not raw:
        raise ProxySetupError("Proxy address must not be empty")
    kde_match = re.fullmatch(r"(?:(https?)://)?([^\s]+)\s+(\d+)", raw, re.IGNORECASE)
    if kde_match:
        scheme = kde_match.group(1) or "http"
        raw = f"{scheme}://{kde_match.group(2)}:{kde_match.group(3)}"
    if "://" not in raw:
        raw = f"http://{raw}"
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise ProxySetupError(f"Only HTTP/HTTPS proxies are supported; unsupported {parsed.scheme or 'unknown'} scheme")
    if not parsed.hostname:
        raise ProxySetupError("Proxy address is missing a hostname")
    try:
        port = parsed.port
    except ValueError as error:
        raise ProxySetupError(f"Invalid proxy port: {error}") from error
    if port is None:
        raise ProxySetupError("Proxy address must include a port")
    if not 1 <= port <= 65535:
        raise ProxySetupError("Proxy port must be between 1 and 65535")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ProxySetupError("Proxy address must not contain a path, query, or fragment")
    host = parsed.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    credentials = ""
    if parsed.username is not None:
        credentials = urllib.parse.quote(urllib.parse.unquote(parsed.username), safe="")
        if parsed.password is not None:
            credentials += f":{urllib.parse.quote(urllib.parse.unquote(parsed.password), safe='')}"
        credentials += "@"
    return f"{parsed.scheme.lower()}://{credentials}{host}:{port}"


def redact_proxy_url(value: str) -> str:
    """Redact any credentials in a proxy URL."""

    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.username is None:
            return value
        host = parsed.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        return f"{parsed.scheme}://***@{host}:{parsed.port}"
    except (TypeError, ValueError):
        return "<invalid-proxy-url>"


def proxy_is_reachable(url: str, timeout: float = 1.5) -> bool:
    """Check whether the proxy TCP port is listening."""

    parsed = urllib.parse.urlsplit(url)
    try:
        with socket.create_connection((parsed.hostname or "", parsed.port or 0), timeout=timeout):
            return True
    except OSError:
        return False


def _run_text(command: Sequence[str], *, timeout: float = 10) -> str | None:
    """Run a read-only system command and return stdout on success."""

    try:
        result = subprocess.run(
            list(command),
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def parse_windows_proxy_server(value: str) -> ProxySettings | None:
    """Convert Windows ProxyServer text into proxy settings."""

    raw = value.strip()
    if not raw:
        return None
    if ";" not in raw and "=" not in raw:
        return ProxySettings.uniform(raw, source="windows-system-proxy")
    values: dict[str, str] = {}
    for item in raw.split(";"):
        if "=" not in item:
            continue
        key, address = item.split("=", 1)
        values[key.strip().lower()] = address.strip()
    if any(key.startswith("socks") for key in values) and not ({"http", "https"} & values.keys()):
        return None
    http = normalize_proxy_url(values["http"]) if values.get("http") else None
    https = normalize_proxy_url(values["https"]) if values.get("https") else None
    if not http and not https:
        return None
    all_proxy = http if http and http == https else None
    return ProxySettings(http, https, all_proxy, source="windows-system-proxy")


def parse_windows_proxy_override(value: str) -> tuple[str, ...]:
    """Convert Windows ProxyOverride into safely representable NO_PROXY entries.

    Example: ``parse_windows_proxy_override("*.example.com;<local>")``.
    """

    entries = list(DEFAULT_NO_PROXY)
    for raw in value.split(";"):
        item = raw.strip()
        if not item or item.casefold() == "<local>":
            continue
        if item.startswith("*."):
            item = item[1:]
        if "*" in item or "?" in item or (item.startswith("<") and item.endswith(">")):
            continue
        entries.append(item)
    return tuple(dict.fromkeys(entries))


def detect_windows_proxy() -> ProxySettings | None:
    """Read the current Windows user static system proxy."""

    try:
        import winreg

        path = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            enabled = int(winreg.QueryValueEx(key, "ProxyEnable")[0])
            server = str(winreg.QueryValueEx(key, "ProxyServer")[0])
            try:
                override = str(winreg.QueryValueEx(key, "ProxyOverride")[0])
            except OSError:
                override = ""
        settings = parse_windows_proxy_server(server) if enabled else None
        if settings is None:
            return None
        return dataclasses.replace(settings, no_proxy=parse_windows_proxy_override(override))
    except (ImportError, OSError, ValueError, ProxySetupError):
        return None


def parse_scutil_proxy(output: str) -> ProxySettings | None:
    """Convert macOS scutil --proxy output into proxy settings."""

    pairs = {
        match.group(1): match.group(2).strip()
        for match in re.finditer(r"^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$", output, re.MULTILINE)
    }
    http = None
    https = None
    if pairs.get("HTTPEnable") == "1" and pairs.get("HTTPProxy") and pairs.get("HTTPPort"):
        http = normalize_proxy_url(f"{pairs['HTTPProxy']}:{pairs['HTTPPort']}")
    if pairs.get("HTTPSEnable") == "1" and pairs.get("HTTPSProxy") and pairs.get("HTTPSPort"):
        https = normalize_proxy_url(f"{pairs['HTTPSProxy']}:{pairs['HTTPSPort']}")
    if not http and not https:
        return None
    exceptions_match = re.search(
        r"ExceptionsList\s*:\s*<array>\s*\{(?P<body>.*?)^\s*\}",
        output,
        re.MULTILINE | re.DOTALL,
    )
    exceptions = []
    if exceptions_match:
        exceptions = [
            match.group(1).strip()
            for match in re.finditer(
                r"^\s*\d+\s*:\s*(.+?)\s*$", exceptions_match.group("body"), re.MULTILINE
            )
        ]
    no_proxy = tuple(dict.fromkeys([*exceptions, *DEFAULT_NO_PROXY]))
    return ProxySettings(
        http,
        https,
        http if http == https else None,
        no_proxy,
        source="macos-system-proxy",
    )


def detect_macos_proxy() -> ProxySettings | None:
    """Read the macOS static system proxy."""

    output = _run_text(["scutil", "--proxy"])
    if not output:
        return None
    try:
        return parse_scutil_proxy(output)
    except ProxySetupError:
        return None


def _unquote_gsettings(value: str | None) -> str:
    """Remove outer quotes from a gsettings string value."""

    if not value:
        return ""
    return value.strip().strip('"').strip("'")


def detect_gnome_proxy() -> ProxySettings | None:
    """Read GNOME manual proxy settings."""

    mode = _unquote_gsettings(_run_text(["gsettings", "get", "org.gnome.system.proxy", "mode"]))
    if mode != "manual":
        return None

    def endpoint(section: str) -> str | None:
        """Read the host and port from a GNOME proxy section."""

        host = _unquote_gsettings(
            _run_text(["gsettings", "get", f"org.gnome.system.proxy.{section}", "host"])
        )
        port = _unquote_gsettings(
            _run_text(["gsettings", "get", f"org.gnome.system.proxy.{section}", "port"])
        )
        return normalize_proxy_url(f"{host}:{port}") if host and port.isdigit() else None

    try:
        http = endpoint("http")
        https = endpoint("https")
    except ProxySetupError:
        return None
    if not http and not https:
        return None
    ignore_raw = _run_text(["gsettings", "get", "org.gnome.system.proxy", "ignore-hosts"])
    try:
        parsed_ignore = ast.literal_eval(ignore_raw) if ignore_raw else []
        ignore_hosts = [str(item) for item in parsed_ignore] if isinstance(parsed_ignore, (list, tuple)) else []
    except (SyntaxError, ValueError):
        ignore_hosts = []
    no_proxy = tuple(dict.fromkeys([*ignore_hosts, *DEFAULT_NO_PROXY]))
    return ProxySettings(
        http,
        https,
        http if http == https else None,
        no_proxy,
        source="gnome-system-proxy",
    )


def _parse_kde_proxy_file(path: Path) -> ProxySettings | None:
    """Read manual proxy settings from KDE kioslaverc."""

    if not path.is_file():
        return None
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read(path, encoding="utf-8")
        section = parser["Proxy Settings"]
        if section.get("ProxyType", "0").strip() != "1":
            return None
        http = normalize_proxy_url(section["httpProxy"]) if section.get("httpProxy") else None
        https = normalize_proxy_url(section["httpsProxy"]) if section.get("httpsProxy") else None
        bypass = re.split(r"[,;]", section.get("NoProxyFor", ""))
    except (OSError, KeyError, configparser.Error, ProxySetupError):
        return None
    if not http and not https:
        return None
    no_proxy = tuple(dict.fromkeys([*(item.strip() for item in bypass if item.strip()), *DEFAULT_NO_PROXY]))
    return ProxySettings(
        http,
        https,
        http if http == https else None,
        no_proxy,
        source="kde-system-proxy",
    )


def detect_kde_proxy() -> ProxySettings | None:
    """Read KDE manual proxy settings."""

    for executable in ("kreadconfig6", "kreadconfig5"):
        if not shutil.which(executable):
            continue
        proxy_type = _run_text(
            [executable, "--file", "kioslaverc", "--group", "Proxy Settings", "--key", "ProxyType"]
        )
        if proxy_type != "1":
            continue
        http_raw = _run_text(
            [executable, "--file", "kioslaverc", "--group", "Proxy Settings", "--key", "httpProxy"]
        )
        https_raw = _run_text(
            [executable, "--file", "kioslaverc", "--group", "Proxy Settings", "--key", "httpsProxy"]
        )
        try:
            http = normalize_proxy_url(http_raw) if http_raw else None
            https = normalize_proxy_url(https_raw) if https_raw else None
        except ProxySetupError:
            continue
        if http or https:
            return ProxySettings(http, https, http if http == https else None, source="kde-system-proxy")
    return _parse_kde_proxy_file(Path.home() / ".config" / "kioslaverc")


def detect_environment_proxy(environ: Mapping[str, str] | None = None) -> ProxySettings | None:
    """Read standard proxy environment variables commonly used on Linux."""

    source = environ if environ is not None else os.environ

    def value(name: str) -> str | None:
        """Read standard proxy variables in uppercase, then lowercase order."""

        return source.get(name) or source.get(name.lower())

    def supported_value(name: str) -> str | None:
        """Ignore unsupported variables while retaining other valid HTTP proxies."""

        raw = value(name)
        if not raw:
            return None
        try:
            return normalize_proxy_url(raw)
        except ProxySetupError:
            return None

    http = supported_value("HTTP_PROXY")
    https = supported_value("HTTPS_PROXY")
    all_proxy = supported_value("ALL_PROXY")
    if not any((http, https, all_proxy)):
        return None
    no_proxy = tuple(part.strip() for part in (value("NO_PROXY") or "").split(",") if part.strip())
    return ProxySettings(http, https, all_proxy, no_proxy or DEFAULT_NO_PROXY, "environment")


def detect_linux_proxy() -> ProxySettings | None:
    """Read Linux proxies from environment variables, GNOME, then KDE."""

    return detect_environment_proxy() or detect_gnome_proxy() or detect_kde_proxy()


def detect_system_proxy(platform: str | None = None) -> ProxySettings | None:
    """Read a determinable static proxy for the current platform."""

    platform_name = platform or sys.platform
    if platform_name == "win32":
        return detect_windows_proxy()
    if platform_name == "darwin":
        return detect_macos_proxy()
    if platform_name.startswith("linux"):
        return detect_linux_proxy()
    return None


def resolve_proxy_settings(
    *,
    port: int | None = None,
    proxy_url: str | None = None,
    http_proxy_url: str | None = None,
    https_proxy_url: str | None = None,
    all_proxy_url: str | None = None,
    validate_connection: bool = False,
) -> ProxySettings:
    """Resolve explicit options, system settings, then default port 7897."""

    if port is not None:
        if not 1 <= port <= 65535:
            raise ProxySetupError("--port must be between 1 and 65535")
        settings = ProxySettings.uniform(f"http://127.0.0.1:{port}", source="explicit-port")
    elif proxy_url:
        settings = ProxySettings.uniform(proxy_url, source="explicit-url")
    elif any((http_proxy_url, https_proxy_url, all_proxy_url)):
        settings = ProxySettings(
            normalize_proxy_url(http_proxy_url) if http_proxy_url else None,
            normalize_proxy_url(https_proxy_url) if https_proxy_url else None,
            normalize_proxy_url(all_proxy_url) if all_proxy_url else None,
            source="explicit-protocols",
        )
    else:
        settings = detect_system_proxy() or ProxySettings.uniform(DEFAULT_PROXY_URL, source="default-7897")
    if not settings.urls():
        raise ProxySetupError("No usable HTTP/HTTPS proxy address")
    if validate_connection:
        for url in settings.urls():
            if not proxy_is_reachable(url):
                suffix = "; default port 7897 is unavailable; use --port or --proxy-url" if settings.source == "default-7897" else ""
                raise ProxySetupError(f"Cannot connect to proxy {redact_proxy_url(url)}{suffix}")
    return settings


_ENV_LINE = re.compile(r"^(?P<prefix>\s*(?:export\s+)?)(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*=.*$")


def _strip_env_value(value: str) -> str:
    """Remove matching outer quotes from a dotenv value."""

    raw = value.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'"', "'"}:
        raw = raw[1:-1]
    return raw


def _quote_env_value(value: str) -> str:
    """Encode a dotenv value as a stable double-quoted string."""

    return json.dumps(value, ensure_ascii=False)


def _merge_no_proxy(existing: str | None, requested: Iterable[str]) -> str:
    """Merge and deduplicate user and plugin bypass targets."""

    values: list[str] = []
    for item in [*(existing or "").split(","), *requested, *DEFAULT_NO_PROXY]:
        normalized = item.strip()
        if normalized and normalized not in values:
            values.append(normalized)
    return ",".join(values)


def _render_env(existing: str, settings: ProxySettings, newline: str) -> tuple[str, bool]:
    """Preserve unrelated lines and render unique managed proxy keys."""

    lines = existing.splitlines()
    found: set[str] = set()
    existing_no_proxy = None
    legacy_wss = False
    for line in lines:
        match = _ENV_LINE.match(line)
        if not match:
            continue
        key = match.group("key").upper()
        if key == "NO_PROXY" and existing_no_proxy is None:
            existing_no_proxy = _strip_env_value(line.split("=", 1)[1])
        if key == "WSS_PROXY":
            legacy_wss = True

    desired = {
        "HTTP_PROXY": settings.http,
        "HTTPS_PROXY": settings.https,
        "ALL_PROXY": settings.all_proxy,
        "NO_PROXY": _merge_no_proxy(existing_no_proxy, settings.no_proxy),
    }
    output: list[str] = []
    for line in lines:
        match = _ENV_LINE.match(line)
        if not match:
            output.append(line)
            continue
        key = match.group("key").upper()
        if key not in MANAGED_KEYS:
            output.append(line)
            continue
        if key in found:
            continue
        found.add(key)
        if desired[key] is not None:
            output.append(f"{key}={_quote_env_value(desired[key] or '')}")
    for key in MANAGED_KEYS:
        if key not in found and desired[key] is not None:
            output.append(f"{key}={_quote_env_value(desired[key] or '')}")
    rendered = newline.join(output)
    if rendered:
        rendered += newline
    return rendered, legacy_wss


def _verify_env(content: str, settings: ProxySettings) -> None:
    """Validate rendered managed proxy keys and values."""

    values: dict[str, list[str]] = {key: [] for key in MANAGED_KEYS}
    for line in content.splitlines():
        match = _ENV_LINE.match(line)
        if match and match.group("key").upper() in values:
            values[match.group("key").upper()].append(_strip_env_value(line.split("=", 1)[1]))
    expected = {
        "HTTP_PROXY": settings.http,
        "HTTPS_PROXY": settings.https,
        "ALL_PROXY": settings.all_proxy,
    }
    for key, expected_value in expected.items():
        if expected_value is None:
            if values[key]:
                raise ProxySetupError(f"{key} should be removed")
        elif values[key] != [expected_value]:
            raise ProxySetupError(f"{key} write verification failed")
    if len(values["NO_PROXY"]) != 1:
        raise ProxySetupError("NO_PROXY write verification failed")
    bypass = values["NO_PROXY"][0].split(",")
    if not all(item in bypass for item in DEFAULT_NO_PROXY):
        raise ProxySetupError("NO_PROXY is missing local addresses")


def _atomic_write(path: Path, content: bytes, mode: int) -> None:
    """Atomically replace a file in its target directory with specified permissions."""

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
        ) as stream:
            temp_path = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink(missing_ok=True)


def _write_private_backup(path: Path, content: bytes, mode: int) -> None:
    """Write sensitive .env backups with exclusive creation and restrictive permissions."""

    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)
    os.chmod(path, mode)


def merge_env_file(codex_home: Path, settings: ProxySettings, *, dry_run: bool = False) -> EnvMergeResult:
    """Safely merge $CODEX_HOME/.env while preserving unrelated settings."""

    home = Path(codex_home).expanduser().resolve()
    env_path = home / ".env"
    env_existed = env_path.exists()
    original_bytes = env_path.read_bytes() if env_existed else b""
    original_mode = stat.S_IMODE(env_path.stat().st_mode) if env_existed else 0o600
    try:
        existing = original_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ProxySetupError(f"{env_path} is not a valid UTF-8 file") from error
    newline = "\r\n" if "\r\n" in existing else "\n"
    rendered, legacy_wss = _render_env(existing, settings, newline)
    _verify_env(rendered, settings)
    new_bytes = rendered.encode("utf-8")
    changed = new_bytes != original_bytes
    if dry_run or not changed:
        return EnvMergeResult(changed, env_path, None, legacy_wss)

    home.mkdir(parents=True, exist_ok=True)
    backup_path = None
    if env_path.exists():
        backup_dir = home / "plugins" / "data" / "system-proxy-codex" / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            os.chmod(backup_dir, 0o700)
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup_path = backup_dir / f"env-{stamp}.backup"
        _write_private_backup(backup_path, original_bytes, 0o600)

    try:
        _atomic_write(env_path, new_bytes, 0o600)
        _verify_env(env_path.read_text(encoding="utf-8"), settings)
    except Exception:
        if env_existed:
            _atomic_write(env_path, original_bytes, original_mode)
        else:
            env_path.unlink(missing_ok=True)
        raise
    return EnvMergeResult(True, env_path, backup_path, legacy_wss)


def codex_home_from_env(value: str | None = None) -> Path:
    """Resolve the current Codex home directory."""

    raw = value or os.environ.get("CODEX_HOME")
    return Path(raw).expanduser().resolve() if raw else (Path.home() / ".codex").resolve()


def build_parser() -> argparse.ArgumentParser:
    """Create the public CLI argument parser."""

    parser = argparse.ArgumentParser(description="Configure the Codex system proxy and .env")
    exclusive = parser.add_mutually_exclusive_group()
    exclusive.add_argument("--port", type=int, help="Use a custom proxy port on 127.0.0.1")
    exclusive.add_argument("--proxy-url", help="Use one address for HTTP/HTTPS/ALL_PROXY")
    parser.add_argument("--http-proxy-url")
    parser.add_argument("--https-proxy-url")
    parser.add_argument("--all-proxy-url")
    parser.add_argument("--codex-home")
    parser.add_argument("--config-only", action="store_true")
    parser.add_argument("--skip-plugin-install", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    return parser


def validate_arguments(args: argparse.Namespace) -> None:
    """Validate mutually exclusive public options."""

    protocols = (args.http_proxy_url, args.https_proxy_url, args.all_proxy_url)
    if (args.port is not None or args.proxy_url) and any(protocols):
        raise ProxySetupError("--port/--proxy-url cannot be combined with per-protocol proxy options")


def main(argv: Sequence[str] | None = None) -> int:
    """Configure .env proxies; the installer or SessionStart manages the feature flag."""

    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        validate_arguments(args)
        if args.config_only:
            return 0
        if args.verbose:
            print(f"Python: {sys.version.split()[0]}")
            print(f"CODEX_HOME: {codex_home_from_env(args.codex_home)}")
            print(f"Platform: {sys.platform}")
        settings = resolve_proxy_settings(
            port=args.port,
            proxy_url=args.proxy_url,
            http_proxy_url=args.http_proxy_url,
            https_proxy_url=args.https_proxy_url,
            all_proxy_url=args.all_proxy_url,
            validate_connection=not args.dry_run,
        )
        result = merge_env_file(codex_home_from_env(args.codex_home), settings, dry_run=args.dry_run)
        action = "Would update" if args.dry_run and result.changed else "Updated" if result.changed else "No update needed"
        print(f"{action} {result.env_path}, proxy source: {settings.source}")
        for url in settings.urls():
            print(f"Proxy: {redact_proxy_url(url)}")
        if result.backup_path:
            print(f"Backup: {result.backup_path}")
        if result.legacy_wss_proxy_present:
            print("Note: wss_proxy was preserved, but current Codex does not read this nonstandard variable.")
        return 0
    except ProxySetupError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"Error: .env file operation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
