from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from dataclasses import dataclass
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import adapters  # noqa: E402
import dbg_core  # noqa: E402


@dataclass
class Installation:
    tool: str
    root: Path
    version: str | None = None
    architecture: str | None = None
    source: str = "test"


class FakeDownloader:
    def __init__(self, *, archive: Path | None = None, json_value: dict | None = None, file: Path | None = None):
        self.archive = archive
        self.json_value = json_value
        self.file = file
        self.fetches: list[tuple[str, str | None]] = []

    def fetch(self, url: str, sha256: str | None = None) -> Path:
        self.fetches.append((url, sha256))
        result = self.archive if url.endswith(".zip") else self.file
        if result is None:
            raise AssertionError(f"unexpected fetch: {url}")
        return result

    def json(self, url: str) -> dict:
        if self.json_value is None:
            raise AssertionError(f"unexpected json: {url}")
        return self.json_value


class FakeContext:
    def __init__(self, root: Path, downloader: FakeDownloader, release: dict | None = None):
        self.data_dir = root / "data"
        self.backup_dir = root / "backup"
        self.state: dict = {}
        self.downloader = downloader
        self.release = release
        self.deploy_calls = 0
        self.runtime_calls: list[tuple[str, list[str]]] = []

    def latest_release(self, repo: str) -> dict:
        assert repo == adapters.X64DBG_REPO
        assert self.release is not None
        return self.release

    def stage(self, name: str, version: str) -> Path:
        path = self.data_dir / "stage" / name / version
        path.mkdir(parents=True, exist_ok=True)
        return path

    def deploy(self, files: dict[Path, Path]) -> list[str]:
        self.deploy_calls += 1
        return dbg_core.managed_deploy(files, self.state, self.backup_dir)

    def ensure_runtime(self, name: str, requirements: list[str]) -> Path:
        self.runtime_calls.append((name, requirements))
        return self.data_dir / "venv" / "python.exe"

    def resolve_commit(self, repo: str, ref: str = "HEAD") -> str:
        assert repo == adapters.IDA_EXPORT_REPO
        return "a" * 40


def _x64_release() -> dict:
    return {
        "tag_name": "v1.3",
        "draft": False,
        "prerelease": False,
        "assets": [{
            "name": "x64dbg-MCP-Server-v1.3.zip",
            "browser_download_url": "https://example.invalid/x64dbg-MCP-Server-v1.3.zip",
            "digest": "sha256:" + "1" * 64,
        }],
    }


class X64dbgAdapterTests(unittest.TestCase):
    def test_selects_release_asset_deploys_both_architectures_and_preserves_config(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            release_root = root / "x64dbg" / "release"
            for arch, executable in (("x64", "x64dbg.exe"), ("x32", "x32dbg.exe")):
                folder = release_root / arch
                folder.mkdir(parents=True)
                (folder / executable).touch()
            config_path = release_root / "x64" / "mcp_config.json"
            config_path.write_text(json.dumps({"000Huge": "x" * 900, "Custom": {"keep": True}, "Port": 9123, "AuthToken": "kept-token", "IpAddress": "0.0.0.0"}), encoding="utf-8")
            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("x64/plugins/x64dbg-MCP-Server.dp64", b"64")
                output.writestr("x32/plugins/x64dbg-MCP-Server.dp32", b"32")
            ctx = FakeContext(root, FakeDownloader(archive=archive), _x64_release())
            ctx.state["managed_files"] = {str(config_path.resolve()): dbg_core.sha256_file(config_path)}

            result = adapters.install_x64dbg([Installation("x64dbg", release_root)], ctx)

            self.assertEqual((release_root / "x64/plugins/x64dbg-MCP-Server.dp64").read_bytes(), b"64")
            self.assertEqual((release_root / "x32/plugins/x64dbg-MCP-Server.dp32").read_bytes(), b"32")
            updated = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(updated["Custom"], {"keep": True})
            self.assertEqual(updated["IpAddress"], "127.0.0.1")
            self.assertEqual(updated["AuthToken"], "kept-token")
            prefix = config_path.read_bytes()[:512]
            self.assertIn(b'"IpAddress"', prefix)
            self.assertIn(b'"Port"', prefix)
            self.assertIn(b'"AutoStart"', prefix)
            self.assertIn(b'"AuthToken"', prefix)
            self.assertEqual(result["runtime"]["url"], "http://127.0.0.1:9123/")
            self.assertEqual(ctx.deploy_calls, 1)

    def test_backs_up_and_narrowly_adopts_recognizable_existing_config(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            release_root = root / "x64dbg" / "release"
            executable = release_root / "x64" / "x64dbg.exe"
            executable.parent.mkdir(parents=True)
            executable.touch()
            config_path = executable.parent / "mcp_config.json"
            original = '{"IpAddress":"0.0.0.0","Port":9094,"Custom":"user"}'
            config_path.write_text(original, encoding="utf-8")
            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("x64/plugins/x64dbg-MCP-Server.dp64", b"64")
                output.writestr("x32/plugins/x64dbg-MCP-Server.dp32", b"32")
            ctx = FakeContext(root, FakeDownloader(archive=archive), _x64_release())

            adapters.install_x64dbg([Installation("x64dbg", release_root)], ctx)

            updated = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(updated["IpAddress"], "127.0.0.1")
            self.assertEqual(updated["Custom"], "user")
            adoption_backups = list(ctx.backup_dir.glob("*-adopted-mcp_config.json.bak"))
            self.assertEqual(len(adoption_backups), 1)
            self.assertEqual(adoption_backups[0].read_text(encoding="utf-8"), original)
            self.assertTrue((executable.parent / "plugins/x64dbg-MCP-Server.dp64").exists())

            config_path.write_text('{"IpAddress":"127.0.0.1","Port":9094,"Custom":"changed"}', encoding="utf-8")
            with self.assertRaisesRegex(dbg_core.DbgError, "受管文件已被用户修改"):
                adapters.install_x64dbg([Installation("x64dbg", release_root)], ctx)
            self.assertEqual(json.loads(config_path.read_text(encoding="utf-8"))["Custom"], "changed")

    def test_refuses_to_adopt_unrecognized_json_config(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            release_root = root / "x64dbg" / "release"
            executable = release_root / "x64" / "x64dbg.exe"
            executable.parent.mkdir(parents=True)
            executable.touch()
            config_path = executable.parent / "mcp_config.json"
            config_path.write_text('{"Custom":"user"}', encoding="utf-8")
            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("x64/plugins/x64dbg-MCP-Server.dp64", b"64")
                output.writestr("x32/plugins/x64dbg-MCP-Server.dp32", b"32")
            ctx = FakeContext(root, FakeDownloader(archive=archive), _x64_release())

            with self.assertRaisesRegex(dbg_core.DbgError, "拒绝接管无法识别"):
                adapters.install_x64dbg([Installation("x64dbg", release_root)], ctx)

            self.assertEqual(config_path.read_text(encoding="utf-8"), '{"Custom":"user"}')
            self.assertFalse(ctx.backup_dir.exists())

    def test_failed_deploy_restores_temporary_config_ownership(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            release_root = root / "x64dbg" / "release"
            executable = release_root / "x64" / "x64dbg.exe"
            executable.parent.mkdir(parents=True)
            executable.touch()
            config_path = executable.parent / "mcp_config.json"
            original = '{"IpAddress":"0.0.0.0","Port":9094}'
            config_path.write_text(original, encoding="utf-8")
            plugin_target = executable.parent / "plugins/x64dbg-MCP-Server.dp64"
            plugin_target.parent.mkdir()
            plugin_target.write_bytes(b"unmanaged user plugin")
            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("x64/plugins/x64dbg-MCP-Server.dp64", b"official")
                output.writestr("x32/plugins/x64dbg-MCP-Server.dp32", b"32")
            ctx = FakeContext(root, FakeDownloader(archive=archive), _x64_release())

            with self.assertRaisesRegex(dbg_core.DbgError, "拒绝覆盖非 Dbg 管理"):
                adapters.install_x64dbg([Installation("x64dbg", release_root)], ctx)

            self.assertNotIn("managed_files", ctx.state)
            self.assertEqual(config_path.read_text(encoding="utf-8"), original)
            self.assertEqual(plugin_target.read_bytes(), b"unmanaged user plugin")
            self.assertEqual(len(list(ctx.backup_dir.glob("*-adopted-mcp_config.json.bak"))), 1)

    def test_rejects_release_without_exact_asset_before_deploy(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            bad = _x64_release()
            bad["assets"] = []
            ctx = FakeContext(root, FakeDownloader(), bad)
            with self.assertRaisesRegex(dbg_core.DbgError, "必须且只能包含"):
                adapters.install_x64dbg([Installation("x64dbg", root)], ctx)
            self.assertEqual(ctx.deploy_calls, 0)


class WinDbgAdapterTests(unittest.TestCase):
    def test_uses_exact_pypi_version_and_supported_cdb_kd_environment(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            debugger = root / "debuggers" / "x64"
            debugger.mkdir(parents=True)
            (debugger / "cdb.exe").touch()
            (debugger / "kd.exe").touch()
            payload = {"info": {"version": "1.2.2"}, "urls": [{"yanked": False}]}
            ctx = FakeContext(root, FakeDownloader(json_value=payload))
            result = adapters.install_windbg([Installation("windbg", debugger, architecture="x64")], ctx)

            self.assertEqual(ctx.runtime_calls, [("windbg-1.2.2", ["mcp-windbg==1.2.2"])])
            self.assertEqual(result["runtime"]["env"]["CDB_PATH"], str(debugger / "cdb.exe"))
            self.assertEqual(result["runtime"]["env"]["KD_PATH"], str(debugger / "kd.exe"))
            self.assertEqual(ctx.deploy_calls, 1)


class IdaAdapterTests(unittest.TestCase):
    def test_mcp_only_deploys_plugin_and_does_not_change_client_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            plugin_source = root / "venv" / "site-packages" / "ida_pro_mcp" / "mcp-plugin.py"
            plugin_source.parent.mkdir(parents=True)
            plugin_source.write_text("# stable GUI plugin\n", encoding="utf-8")
            ida_user = root / "ida-user"
            client_config = root / "client" / "mcp.json"
            client_config.parent.mkdir()
            client_config.write_text('{"unrelated": true}', encoding="utf-8")
            ctx = FakeContext(root, FakeDownloader())

            with mock.patch.dict("os.environ", {"IDAUSR": str(ida_user)}, clear=False), mock.patch.object(adapters, "_locate_package_file", return_value=plugin_source):
                result = adapters.install_ida_mcp([Installation("ida", root / "IDA", "9.1")], ctx)

            self.assertEqual((ida_user / "plugins/mcp-plugin.py").read_text(encoding="utf-8"), "# stable GUI plugin\n")
            self.assertEqual(client_config.read_text(encoding="utf-8"), '{"unrelated": true}')
            self.assertEqual(result["runtime"]["command"][-2:], ["-m", "ida_pro_mcp"])
            self.assertEqual(ctx.deploy_calls, 1)

    def test_reports_known_unsupported_ida_before_runtime_or_deploy(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            ctx = FakeContext(root, FakeDownloader())
            result = adapters.install_ida_mcp([Installation("ida", root, "8.2")], ctx)
            self.assertEqual(result["status"], "unsupported")
            self.assertIn("最低支持 IDA 8.3", result["message"])
            self.assertNotIn("runtime", result)
            self.assertEqual(ctx.runtime_calls, [])
            self.assertEqual(ctx.deploy_calls, 0)

    def test_ida_mcp_does_not_install_when_version_is_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            ctx = FakeContext(root, FakeDownloader())
            result = adapters.install_ida_mcp([Installation("ida", root, None)], ctx)
            self.assertEqual(result["status"], "unsupported")
            self.assertIn("未知版本", result["message"])
            self.assertEqual(ctx.runtime_calls, [])
            self.assertEqual(ctx.deploy_calls, 0)

    def test_ida_free_is_rejected_before_download_even_with_new_version(self) -> None:
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir).resolve()
            host = SimpleNamespace(root=root, version="9.3", edition="free")
            for install in (adapters.install_ida_mcp, adapters.install_ida_export):
                ctx = FakeContext(root, FakeDownloader())
                result = install([host], ctx)
                self.assertEqual(result["status"], "unsupported")
                self.assertIn("IDAPython", result["message"])
                self.assertEqual(ctx.runtime_calls, [])
                self.assertEqual(ctx.downloader.fetches, [])
                self.assertEqual(ctx.deploy_calls, 0)

    def test_exporter_reports_ida_8_2_unsupported_without_deploying(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "INP.py"
            source.write_text("# exporter\n", encoding="utf-8")
            ctx = FakeContext(root, FakeDownloader(file=source))
            with mock.patch.dict("os.environ", {"IDAUSR": str(root / "ida-user")}, clear=False):
                result = adapters.install_ida_export([Installation("ida", root / "IDA", "8.2")], ctx)
            self.assertEqual(result["status"], "unsupported")
            self.assertIn("未声明", result["message"])
            self.assertFalse((root / "ida-user/plugins/INP.py").exists())
            self.assertEqual(ctx.deploy_calls, 0)

    def test_exporter_does_not_resolve_or_download_when_version_is_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            ctx = FakeContext(root, FakeDownloader())
            with mock.patch.object(ctx, "resolve_commit", wraps=ctx.resolve_commit) as resolve:
                result = adapters.install_ida_export([Installation("ida", root, "")], ctx)
            self.assertEqual(result["status"], "unsupported")
            self.assertIn("未知版本", result["message"])
            resolve.assert_not_called()
            self.assertEqual(ctx.downloader.fetches, [])
            self.assertEqual(ctx.deploy_calls, 0)

    def test_exporter_uses_exact_commit_and_idausr_without_mcp_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "INP.py"
            source.write_text("# exporter\n", encoding="utf-8")
            ctx = FakeContext(root, FakeDownloader(file=source))
            with mock.patch.dict("os.environ", {"IDAUSR": str(root / "ida-user")}, clear=False):
                result = adapters.install_ida_export([Installation("ida", root / "IDA", "9.3")], ctx)
            self.assertEqual(result["version"], "a" * 40)
            self.assertEqual(result["runtime"]["type"], "ida-plugin")
            self.assertTrue((root / "ida-user/plugins/INP.py").is_file())
            self.assertEqual(ctx.deploy_calls, 1)


if __name__ == "__main__":
    unittest.main()
