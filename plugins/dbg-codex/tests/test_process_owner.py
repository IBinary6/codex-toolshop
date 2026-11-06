"""Verify that session cleanup stays scoped to the processes it owns."""
import ctypes
from ctypes import wintypes
import errno
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import venv


ROUTER = Path(__file__).resolve().parents[1] / "scripts" / "managed_server.py"
sys.path.insert(0, str(ROUTER.parent))
from process_owner import ProcessOwner

NODE_OWNER = """
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [python, router, pidFile] = process.argv.slice(1);
const child = spawn(python, [router, 'ghidra'], {
  env: {...process.env, DBG_MCP_OWNER_PID: String(process.pid)},
  stdio: 'inherit', windowsHide: true,
});
child.on('spawn', () => fs.writeFileSync(pidFile, String(child.pid)));
child.on('exit', (code) => process.exitCode = code ?? 1);
"""
BACKEND = """
import json, os, pathlib, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
worker = ('import os, pathlib, sys, time; root = pathlib.Path(sys.argv[1]); '
          'temp = root / "worker.tmp"; temp.write_text(str(os.getpid())); '
          'temp.replace(root / "worker.pid"); time.sleep(120)')
child = subprocess.Popen([sys.executable, '-c', worker, str(root)],
                         creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
while not (root / 'worker.pid').is_file():
    time.sleep(0.02)
temp = root / 'tree.tmp'
temp.write_text(json.dumps({'backend': os.getpid(), 'child': child.pid,
                            'worker': int((root / 'worker.pid').read_text())}))
temp.replace(root / 'tree.json')
while not (root / 'exit').exists():
    time.sleep(0.02)
raise SystemExit(17)
"""


class DarwinPermissionTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.object(signal, "SIGKILL", getattr(signal, "SIGKILL", 9), create=True))
        self.owner = ProcessOwner.__new__(ProcessOwner)
        self.owner._group = 1234
        self.owner._closed = threading.Event()
        self.owner._lock = threading.Lock()

    def test_zombie_only_group_does_not_fail_shutdown(self):
        with mock.patch("process_owner.sys.platform", "darwin"), \
             mock.patch("process_owner.os.killpg", create=True,
                        side_effect=PermissionError(errno.EPERM, "denied")) as kill_group, \
             mock.patch("process_owner.subprocess.run", return_value=subprocess.CompletedProcess(
                 [], 0, stdout=b"1234 1234 Zs\n2345 1234 Z\n", stderr=b"")):
            self.owner.close()
            self.owner.close()
        self.assertTrue(self.owner._closed.is_set())
        kill_group.assert_called_once_with(1234, signal.SIGKILL)

    def test_live_or_unverified_group_preserves_permission_error(self):
        for output in (b"1234 1234 Zs\n2345 1234 S\n", b"2345 1234 Z\n", b"1234 4321 Z\n", b""):
            with self.subTest(output=output), mock.patch("process_owner.sys.platform", "darwin"), \
                 mock.patch("process_owner.os.killpg", create=True,
                            side_effect=PermissionError(errno.EPERM, "denied")), \
                 mock.patch("process_owner.subprocess.run", return_value=subprocess.CompletedProcess(
                     [], 0, stdout=output, stderr=b"")):
                with self.assertRaises(PermissionError):
                    self.owner.close()
                self.assertFalse(self.owner._closed.is_set())


@unittest.skipIf(os.name == "nt", "requires a POSIX process group")
class PosixProcessOwnerTests(unittest.TestCase):
    def test_backend_exit_preserves_status_and_stops_living_group_member(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = (
                "import subprocess, sys\n"
                "subprocess.Popen([sys.executable, '-c', "
                "'import time; time.sleep(5); print(\"worker survived\")'])\n"
                "print('backend exited', flush=True)\n"
                "raise SystemExit(17)\n"
            )
            state = {"tools": {"ghidra": {"runtime": {"command": [sys.executable, "-c", backend]}}}}
            (root / "state.json").write_text(json.dumps(state), encoding="utf-8")
            unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
            try:
                router = subprocess.run([sys.executable, str(ROUTER), "ghidra"], input="",
                                        capture_output=True, text=True, timeout=15,
                                        env={**os.environ, "DBG_HOME": str(root)})
                self.assertEqual(router.returncode, 17, router.stderr)
                self.assertEqual(router.stdout, "backend exited\n")
                self.assertIsNone(unrelated.poll())
            finally:
                unrelated.terminate()
                unrelated.wait(timeout=5)


class WindowsProcess:
    """Hold a handle from fixture startup through cleanup, independent of PID reuse."""

    def __init__(self, pid):
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.wait = kernel.WaitForSingleObject
        self.wait.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        self.wait.restype = wintypes.DWORD
        self.terminate = kernel.TerminateProcess
        self.terminate.argtypes = (wintypes.HANDLE, wintypes.UINT)
        self.terminate.restype = wintypes.BOOL
        self.close = kernel.CloseHandle
        self.close.argtypes = (wintypes.HANDLE,)
        self.close.restype = wintypes.BOOL
        open_process = kernel.OpenProcess
        open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        open_process.restype = wintypes.HANDLE
        self.handle = open_process(0x100001, False, pid)  # SYNCHRONIZE | PROCESS_TERMINATE
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())

    def exited(self, milliseconds=0):
        result = self.wait(self.handle, milliseconds)
        if result not in (0, 258):
            raise ctypes.WinError(ctypes.get_last_error())
        return result == 0

    def kill(self):
        if not self.exited() and not self.terminate(self.handle, 1) and not self.exited():
            raise ctypes.WinError(ctypes.get_last_error())

    def cleanup(self):
        try:
            self.kill()
            self.exited(2000)
        finally:
            self.close(self.handle)


@unittest.skipUnless(os.name == "nt", "requires Windows process handles and a Windows venv redirector")
class WindowsProcessOwnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temporary.cleanup)
        environment = Path(temporary.name) / "venv"
        venv.EnvBuilder(with_pip=False).create(environment)
        cls.venv_python = environment / "Scripts" / "python.exe"

    def watch(self, pid):
        process = WindowsProcess(pid)
        self.addCleanup(process.cleanup)
        return process

    def start(self, command, **options):
        process = subprocess.Popen(command, creationflags=subprocess.CREATE_NO_WINDOW, **options)

        def cleanup():
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            if process.stdin:
                process.stdin.close()

        self.addCleanup(cleanup)
        return process

    def session(self, *, router_python=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        backend = root / "backend.py"
        backend.write_text(BACKEND, encoding="utf-8")
        command = [str(self.venv_python), str(backend), str(root)]
        state = {"tools": {"ghidra": {"runtime": {"command": command}}}}
        (root / "state.json").write_text(json.dumps(state), encoding="utf-8")
        owner = self.start(["node", "-e", NODE_OWNER, str(router_python or sys.executable), str(ROUTER),
                            str(root / "router.pid")], stdin=subprocess.PIPE,
                           env={**os.environ, "DBG_HOME": str(root), "PYTHONUTF8": "1"})
        deadline = time.monotonic() + 12
        while not (root / "tree.json").is_file():
            self.assertIsNone(owner.poll(), "launcher exited before its backend started")
            self.assertLess(time.monotonic(), deadline, "backend startup timed out")
            time.sleep(0.02)
        router = self.watch(int((root / "router.pid").read_text()))
        pids = json.loads((root / "tree.json").read_text())
        self.assertNotEqual(pids["child"], pids["worker"], "fixture must use the Windows venv redirector")
        tree = {name: self.watch(pid) for name, pid in pids.items()}
        return root, owner, router, tree

    def assert_tree_exited(self, router, tree):
        self.assertTrue(router.exited(5000), "managed_server survived shutdown")
        for name, process in tree.items():
            self.assertTrue(process.exited(2000), f"owned {name} survived shutdown")

    def test_ignored_eof_then_router_force_stop_reaps_venv_descendants(self):
        _, owner, router, tree = self.session(router_python=self.venv_python)
        owner.stdin.close()
        self.assertFalse(tree["backend"].exited(150), "fixture must ignore EOF")
        router.kill()  # Launcher escalates to its own router after the EOF grace period.
        self.assert_tree_exited(router, tree)
        owner.wait(timeout=5)

    def test_owner_force_exit_reaps_tree_with_open_stdin_and_preserves_other_session(self):
        gui = self.start([sys.executable, "-c", "import time; time.sleep(120)"])
        _, other, other_router, other_tree = self.session()
        _, owner, router, tree = self.session()
        owner.kill()
        owner.wait(timeout=5)
        self.assertFalse(owner.stdin.closed)
        self.assert_tree_exited(router, tree)
        self.assertIsNone(gui.poll())
        self.assertIsNone(other.poll())
        self.assertFalse(other_router.exited())
        self.assertTrue(all(not process.exited() for process in other_tree.values()))

    def test_backend_exit_preserves_status_and_reaps_remaining_grandchild(self):
        root, owner, router, tree = self.session()
        (root / "exit").touch()
        self.assertEqual(owner.wait(timeout=5), 17)
        self.assert_tree_exited(router, tree)


if __name__ == "__main__":
    unittest.main()
