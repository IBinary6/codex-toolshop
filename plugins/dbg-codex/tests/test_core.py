from __future__ import annotations

import hashlib
import http.server
import io
import json
import os
import stat
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import dbg_core  # noqa: E402


class JsonAndHashTests(unittest.TestCase):
    def test_default_data_dir_honors_dbg_home(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir, mock.patch.dict(
            os.environ, {"DBG_HOME": raw_dir}, clear=False
        ):
            self.assertEqual(dbg_core.default_data_dir(), Path(raw_dir))

    def test_atomic_json_round_trip_uses_utf8(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "state.json"
            dbg_core.atomic_json(path, {"名称": "调试器", "enabled": True})

            self.assertEqual(
                dbg_core.load_json(path), {"名称": "调试器", "enabled": True}
            )
            path.read_text(encoding="utf-8")

    def test_load_json_returns_default_only_when_file_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "missing.json"
            self.assertEqual(dbg_core.load_json(path, {"fresh": True}), {"fresh": True})
            path.write_text("not json", encoding="utf-8")
            with self.assertRaises(dbg_core.DbgError):
                dbg_core.load_json(path)


class FileLockTests(unittest.TestCase):
    def test_waiting_windows_holder_acquires_lock_after_release(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            lock_path = Path(raw_dir) / "state.lock"
            attempting = threading.Event()
            acquired = threading.Event()
            failures: list[BaseException] = []

            def wait_for_lock() -> None:
                attempting.set()
                try:
                    with dbg_core.FileLock(lock_path, timeout=0.5):
                        acquired.set()
                except BaseException as exc:
                    failures.append(exc)

            with dbg_core.FileLock(lock_path):
                waiter = threading.Thread(target=wait_for_lock)
                waiter.start()
                self.assertTrue(attempting.wait(timeout=1))
                time.sleep(0.15)
                self.assertFalse(acquired.is_set())

            waiter.join(timeout=2)
            self.assertFalse(waiter.is_alive())
            self.assertEqual(failures, [])
            self.assertTrue(acquired.is_set())

    def test_second_holder_times_out_without_releasing_first_lock(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            lock_path = Path(raw_dir) / "state.lock"
            with dbg_core.FileLock(lock_path):
                with self.assertRaises(dbg_core.DbgError):
                    with dbg_core.FileLock(lock_path, timeout=0):
                        self.fail("同一文件不应同时取得两把排他锁")

            with dbg_core.FileLock(lock_path, timeout=0):
                pass


class ZipExtractionTests(unittest.TestCase):
    def test_extracts_regular_files(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            archive = root / "good.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("tool/bin/tool.txt", "ok")

            destination = root / "out"
            dbg_core.safe_extract_zip(archive, destination)
            self.assertEqual((destination / "tool/bin/tool.txt").read_text(), "ok")

    def test_rejects_all_unsafe_members_before_writing_any_file(self) -> None:
        unsafe_names = (
            "../escape.txt",
            "/absolute.txt",
            "C:/drive.txt",
            "safe/..\\escape.txt",
        )
        for unsafe_name in unsafe_names:
            with self.subTest(unsafe_name=unsafe_name), tempfile.TemporaryDirectory() as raw_dir:
                root = Path(raw_dir)
                archive = root / "bad.zip"
                with zipfile.ZipFile(archive, "w") as output:
                    output.writestr("would-have-been-created.txt", "partial")
                    output.writestr(unsafe_name, "bad")

                destination = root / "out"
                with self.assertRaises(dbg_core.DbgError):
                    dbg_core.safe_extract_zip(archive, destination)
                self.assertFalse((destination / "would-have-been-created.txt").exists())

    def test_rejects_symbolic_link_member(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            archive = root / "link.zip"
            link = zipfile.ZipInfo("link")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr(link, "target")

            with self.assertRaises(dbg_core.DbgError):
                dbg_core.safe_extract_zip(archive, root / "out")


class DownloaderTests(unittest.TestCase):
    def test_json_refreshes_changed_loopback_source_each_time(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "release.json"
            source.write_text('{"version": "1"}', encoding="utf-8")

            class QuietHandler(http.server.SimpleHTTPRequestHandler):
                def log_message(self, format: str, *args: object) -> None:
                    pass

            handler = lambda *args, **kwargs: QuietHandler(  # noqa: E731
                *args, directory=str(root), **kwargs
            )
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                downloader = dbg_core.Downloader(root / "cache")
                url = f"http://127.0.0.1:{server.server_port}/release.json"
                self.assertEqual(downloader.json(url), {"version": "1"})
                source.write_text('{"version": "2"}', encoding="utf-8")
                self.assertEqual(downloader.json(url), {"version": "2"})
                cached = downloader._cache_path(url)
                source.write_text('{"version":', encoding="utf-8")
                with self.assertRaises(dbg_core.DbgError):
                    downloader.json(url)
                self.assertEqual(json.loads(cached.read_text(encoding="utf-8")), {"version": "2"})
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_fetch_without_upstream_digest_uses_sidecar_to_detect_corruption(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            downloader = dbg_core.Downloader(Path(raw_dir))
            url = "https://example.invalid/tool.bin"
            responses = []
            for payload in (b"first", b"second"):
                response = mock.MagicMock()
                response.__enter__.return_value.read.return_value = payload
                response.__exit__.return_value = False
                responses.append(response)

            with mock.patch.object(
                dbg_core.urllib.request, "urlopen", side_effect=responses
            ) as get:
                downloaded = downloader.fetch(url)
                self.assertEqual(downloaded.read_bytes(), b"first")
                downloaded.write_bytes(b"corrupt")
                self.assertEqual(downloader.fetch(url).read_bytes(), b"second")
                self.assertEqual(get.call_count, 2)

    def test_fetch_reuses_valid_cache_and_replaces_corrupt_cache(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            cache = Path(raw_dir)
            downloader = dbg_core.Downloader(cache)
            url = "https://example.invalid/releases/tool.zip"
            payload = b"release payload"
            digest = hashlib.sha256(payload).hexdigest()
            response = mock.MagicMock()
            response.__enter__.return_value.read.return_value = payload
            response.__exit__.return_value = False

            with mock.patch.object(dbg_core.urllib.request, "urlopen", return_value=response) as get:
                downloaded = downloader.fetch(url, digest)
                self.assertEqual(downloaded.read_bytes(), payload)
                self.assertEqual(get.call_count, 1)

                self.assertEqual(downloader.fetch(url, digest), downloaded)
                self.assertEqual(get.call_count, 1)

                downloaded.write_bytes(b"corrupt")
                self.assertEqual(downloader.fetch(url, digest).read_bytes(), payload)
                self.assertEqual(get.call_count, 2)

    def test_failed_download_does_not_replace_existing_cache(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            downloader = dbg_core.Downloader(Path(raw_dir))
            url = "https://example.invalid/tool.bin"
            expected = hashlib.sha256(b"good").hexdigest()
            cache_path = downloader._cache_path(url)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(b"existing")
            response = mock.MagicMock()
            response.__enter__.return_value.read.return_value = b"bad"
            response.__exit__.return_value = False

            with mock.patch.object(dbg_core.urllib.request, "urlopen", return_value=response):
                with self.assertRaises(dbg_core.DbgError):
                    downloader.fetch(url, expected)
            self.assertEqual(cache_path.read_bytes(), b"existing")

    def test_rejects_plain_http_except_loopback(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            downloader = dbg_core.Downloader(Path(raw_dir))
            with self.assertRaises(dbg_core.DbgError):
                downloader.fetch("http://example.com/tool.zip")

    def test_allows_loopback_http_for_local_tests(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            downloader = dbg_core.Downloader(Path(raw_dir))
            response = mock.MagicMock()
            response.__enter__.return_value.read.return_value = b"local"
            response.__exit__.return_value = False
            with mock.patch.object(dbg_core.urllib.request, "urlopen", return_value=response):
                result = downloader.fetch("http://localhost:8765/tool.bin")
            self.assertEqual(result.read_bytes(), b"local")


class ManagedDeployTests(unittest.TestCase):
    def test_is_idempotent_and_repairs_a_missing_managed_file(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "prepared" / "tool.txt"
            source.parent.mkdir()
            source.write_text("v1", encoding="utf-8")
            target = root / "installed" / "tool.txt"
            state: dict[str, object] = {}

            self.assertEqual(
                dbg_core.managed_deploy({target: source}, state, root / "backups"),
                [str(target.resolve())],
            )
            self.assertEqual(dbg_core.managed_deploy({target: source}, state, root / "backups"), [])
            target.unlink()
            self.assertEqual(
                dbg_core.managed_deploy({target: source}, state, root / "backups"),
                [str(target.resolve())],
            )

    def test_refuses_unmanaged_or_user_modified_target(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "source.txt"
            source.write_text("new", encoding="utf-8")
            target = root / "target.txt"
            target.write_text("user", encoding="utf-8")
            state: dict[str, object] = {}

            with self.assertRaises(dbg_core.DbgError):
                dbg_core.managed_deploy({target: source}, state, root / "backup")
            state["managed_files"] = {str(target.resolve()): hashlib.sha256(b"old").hexdigest()}
            with self.assertRaises(dbg_core.DbgError):
                dbg_core.managed_deploy({target: source}, state, root / "backup")
            self.assertEqual(target.read_text(encoding="utf-8"), "user")

    def test_second_replace_failure_rolls_back_files_and_state(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source_a, source_b = root / "source-a", root / "source-b"
            target_a, target_b = root / "target-a", root / "target-b"
            source_a.write_text("new-a")
            source_b.write_text("new-b")
            target_a.write_text("old-a")
            target_b.write_text("old-b")
            state: dict[str, object] = {
                "managed_files": {
                    str(target_a.resolve()): dbg_core.sha256_file(target_a),
                    str(target_b.resolve()): dbg_core.sha256_file(target_b),
                }
            }
            original_state = json.loads(json.dumps(state))
            real_replace = os.replace
            failed = False

            def fail_second(source: object, destination: object) -> None:
                nonlocal failed
                if Path(destination) == target_b and not failed:
                    failed = True
                    raise OSError("injected second-file failure")
                real_replace(source, destination)

            with mock.patch.object(dbg_core.os, "replace", side_effect=fail_second):
                with self.assertRaises(dbg_core.DbgError):
                    dbg_core.managed_deploy(
                        {target_a: source_a, target_b: source_b}, state, root / "backup"
                    )

            self.assertEqual(target_a.read_text(), "old-a")
            self.assertEqual(target_b.read_text(), "old-b")
            self.assertEqual(state, original_state)


if __name__ == "__main__":
    unittest.main()
