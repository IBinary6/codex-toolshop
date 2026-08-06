#!/usr/bin/env python3
"""配置 Codex 代理环境与系统代理功能。"""

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
    """表示无法安全完成代理配置。"""


@dataclasses.dataclass(frozen=True)
class ProxySettings:
    """描述将写入 Codex 环境的代理地址。"""

    http: str | None
    https: str | None
    all_proxy: str | None
    no_proxy: tuple[str, ...] = DEFAULT_NO_PROXY
    source: str = "unknown"

    @classmethod
    def uniform(cls, url: str, *, source: str) -> "ProxySettings":
        """使用同一地址创建 HTTP、HTTPS 与通用代理配置。"""

        normalized = normalize_proxy_url(url)
        return cls(normalized, normalized, normalized, source=source)

    def urls(self) -> tuple[str, ...]:
        """返回去重后的非空代理地址。"""

        return tuple(dict.fromkeys(value for value in (self.http, self.https, self.all_proxy) if value))


@dataclasses.dataclass(frozen=True)
class EnvMergeResult:
    """描述一次 `.env` 合并的结果。"""

    changed: bool
    env_path: Path
    backup_path: Path | None
    legacy_wss_proxy_present: bool


def normalize_proxy_url(value: str) -> str:
    """校验并规范化 HTTP(S) 代理 URL。"""

    raw = value.strip().strip('"').strip("'")
    if not raw:
        raise ProxySetupError("代理地址不能为空")
    kde_match = re.fullmatch(r"(?:(https?)://)?([^\s]+)\s+(\d+)", raw, re.IGNORECASE)
    if kde_match:
        scheme = kde_match.group(1) or "http"
        raw = f"{scheme}://{kde_match.group(2)}:{kde_match.group(3)}"
    if "://" not in raw:
        raw = f"http://{raw}"
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise ProxySetupError(f"仅支持 HTTP/HTTPS 代理，不支持 {parsed.scheme or '未知'} scheme")
    if not parsed.hostname:
        raise ProxySetupError("代理地址缺少主机名")
    try:
        port = parsed.port
    except ValueError as error:
        raise ProxySetupError(f"代理端口无效: {error}") from error
    if port is None:
        raise ProxySetupError("代理地址必须包含端口")
    if not 1 <= port <= 65535:
        raise ProxySetupError("代理端口必须位于 1 到 65535")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ProxySetupError("代理地址不能包含路径、查询参数或 fragment")
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
    """隐藏代理 URL 中可能存在的凭据。"""

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
    """检查代理 TCP 端口是否正在监听。"""

    parsed = urllib.parse.urlsplit(url)
    try:
        with socket.create_connection((parsed.hostname or "", parsed.port or 0), timeout=timeout):
            return True
    except OSError:
        return False


def _run_text(command: Sequence[str], *, timeout: float = 10) -> str | None:
    """运行只读系统命令并返回成功的标准输出。"""

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
    """把 Windows `ProxyServer` 文本转换为代理设置。"""

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


def detect_windows_proxy() -> ProxySettings | None:
    """读取 Windows 当前用户的静态系统代理。"""

    try:
        import winreg

        path = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            enabled = int(winreg.QueryValueEx(key, "ProxyEnable")[0])
            server = str(winreg.QueryValueEx(key, "ProxyServer")[0])
        return parse_windows_proxy_server(server) if enabled else None
    except (ImportError, OSError, ValueError, ProxySetupError):
        return None


def parse_scutil_proxy(output: str) -> ProxySettings | None:
    """把 macOS `scutil --proxy` 输出转换为代理设置。"""

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
    """读取 macOS 的静态系统代理。"""

    output = _run_text(["scutil", "--proxy"])
    if not output:
        return None
    try:
        return parse_scutil_proxy(output)
    except ProxySetupError:
        return None


def _unquote_gsettings(value: str | None) -> str:
    """移除 `gsettings` 字符串值的外层引号。"""

    if not value:
        return ""
    return value.strip().strip('"').strip("'")


def detect_gnome_proxy() -> ProxySettings | None:
    """读取 GNOME 手动代理设置。"""

    mode = _unquote_gsettings(_run_text(["gsettings", "get", "org.gnome.system.proxy", "mode"]))
    if mode != "manual":
        return None

    def endpoint(section: str) -> str | None:
        """读取一个 GNOME 代理分区的主机与端口。"""

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
    """读取 KDE `kioslaverc` 中的手动代理设置。"""

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
    """读取 KDE 手动代理设置。"""

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
    """读取 Linux 常用的标准代理环境变量。"""

    source = environ if environ is not None else os.environ

    def value(name: str) -> str | None:
        """按大写、小写顺序读取标准代理变量。"""

        return source.get(name) or source.get(name.lower())

    def supported_value(name: str) -> str | None:
        """忽略单个不支持的变量而保留其他有效 HTTP 代理。"""

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
    """按环境变量、GNOME、KDE 顺序读取 Linux 代理。"""

    return detect_environment_proxy() or detect_gnome_proxy() or detect_kde_proxy()


def detect_system_proxy(platform: str | None = None) -> ProxySettings | None:
    """按当前平台读取可确定的静态代理。"""

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
    """按显式参数、系统设置、默认 7897 的顺序解析代理。"""

    if port is not None:
        if not 1 <= port <= 65535:
            raise ProxySetupError("--port 必须位于 1 到 65535")
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
        raise ProxySetupError("没有可用的 HTTP/HTTPS 代理地址")
    if validate_connection:
        for url in settings.urls():
            if not proxy_is_reachable(url):
                suffix = "；默认端口 7897 不可用，请使用 --port 或 --proxy-url" if settings.source == "default-7897" else ""
                raise ProxySetupError(f"无法连接代理 {redact_proxy_url(url)}{suffix}")
    return settings


_ENV_LINE = re.compile(r"^(?P<prefix>\s*(?:export\s+)?)(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*=.*$")


def _strip_env_value(value: str) -> str:
    """移除 dotenv 值最外层的匹配引号。"""

    raw = value.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'"', "'"}:
        raw = raw[1:-1]
    return raw


def _quote_env_value(value: str) -> str:
    """把 dotenv 值编码为稳定的双引号字符串。"""

    return json.dumps(value, ensure_ascii=False)


def _merge_no_proxy(existing: str | None, requested: Iterable[str]) -> str:
    """合并并去重用户与插件要求的直连目标。"""

    values: list[str] = []
    for item in [*(existing or "").split(","), *requested, *DEFAULT_NO_PROXY]:
        normalized = item.strip()
        if normalized and normalized not in values:
            values.append(normalized)
    return ",".join(values)


def _render_env(existing: str, settings: ProxySettings, newline: str) -> tuple[str, bool]:
    """保留无关行并渲染唯一的受管代理键。"""

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
    """验证渲染后的受管代理键和值。"""

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
                raise ProxySetupError(f"{key} 应被移除")
        elif values[key] != [expected_value]:
            raise ProxySetupError(f"{key} 写入验证失败")
    if len(values["NO_PROXY"]) != 1:
        raise ProxySetupError("NO_PROXY 写入验证失败")
    bypass = values["NO_PROXY"][0].split(",")
    if not all(item in bypass for item in DEFAULT_NO_PROXY):
        raise ProxySetupError("NO_PROXY 缺少本机地址")


def _atomic_write(path: Path, content: bytes, mode: int) -> None:
    """以指定权限在目标目录内原子替换文件。"""

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
    """使用排他创建和收紧后的权限写入敏感 `.env` 备份。"""

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
    """安全合并 `$CODEX_HOME/.env` 并保留无关配置。"""

    home = Path(codex_home).expanduser().resolve()
    env_path = home / ".env"
    env_existed = env_path.exists()
    original_bytes = env_path.read_bytes() if env_existed else b""
    original_mode = stat.S_IMODE(env_path.stat().st_mode) if env_existed else 0o600
    try:
        existing = original_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ProxySetupError(f"{env_path} 不是有效的 UTF-8 文件") from error
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
    """解析当前 Codex 主目录。"""

    raw = value or os.environ.get("CODEX_HOME")
    return Path(raw).expanduser().resolve() if raw else (Path.home() / ".codex").resolve()


def build_parser() -> argparse.ArgumentParser:
    """创建公开 CLI 参数解析器。"""

    parser = argparse.ArgumentParser(description="配置 Codex 系统代理与 .env")
    exclusive = parser.add_mutually_exclusive_group()
    exclusive.add_argument("--port", type=int, help="使用 127.0.0.1 上的自定义代理端口")
    exclusive.add_argument("--proxy-url", help="统一 HTTP/HTTPS/ALL_PROXY 地址")
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
    """验证互斥的公开参数组合。"""

    protocols = (args.http_proxy_url, args.https_proxy_url, args.all_proxy_url)
    if (args.port is not None or args.proxy_url) and any(protocols):
        raise ProxySetupError("--port/--proxy-url 不能与分协议代理参数同时使用")


def main(argv: Sequence[str] | None = None) -> int:
    """执行 `.env` 代理设置；配置功能由安装器或 SessionStart 负责。"""

    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        validate_arguments(args)
        if args.config_only:
            return 0
        if args.verbose:
            print(f"Python: {sys.version.split()[0]}")
            print(f"CODEX_HOME: {codex_home_from_env(args.codex_home)}")
            print(f"平台: {sys.platform}")
        settings = resolve_proxy_settings(
            port=args.port,
            proxy_url=args.proxy_url,
            http_proxy_url=args.http_proxy_url,
            https_proxy_url=args.https_proxy_url,
            all_proxy_url=args.all_proxy_url,
            validate_connection=not args.dry_run,
        )
        result = merge_env_file(codex_home_from_env(args.codex_home), settings, dry_run=args.dry_run)
        action = "将更新" if args.dry_run and result.changed else "已更新" if result.changed else "无需更新"
        print(f"{action} {result.env_path}，代理来源: {settings.source}")
        for url in settings.urls():
            print(f"代理: {redact_proxy_url(url)}")
        if result.backup_path:
            print(f"备份: {result.backup_path}")
        if result.legacy_wss_proxy_present:
            print("提示: 已保留 wss_proxy，但当前 Codex 不读取该非标准变量。")
        return 0
    except ProxySetupError as error:
        print(f"错误: {error}", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"错误: .env 文件操作失败: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
