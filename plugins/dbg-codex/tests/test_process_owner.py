"""Use real Windows process handles to verify that only a session's own tree exits."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import venv


ROUTER = Path(__file__).resolve().parents[1] / "scripts" / "managed_server.py"
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
