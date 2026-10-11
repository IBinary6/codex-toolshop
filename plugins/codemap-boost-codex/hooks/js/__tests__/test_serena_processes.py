"""Permission and identity changes that should not be injected into real processes."""

import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import select
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

import psutil


SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "serena-processes.py"
spec = importlib.util.spec_from_file_location("serena_processes", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
OWNER = "12345678-1234-1234-1234-123456789abc"
PROTECTED_PROCESS = """
import ctypes
import time
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(4, 0, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno())
print('READY', flush=True)
while True:
    time.sleep(0.1)
"""
LINUX_CALLER = """
import json
import os
import psutil
import select
import subprocess
import sys
import uuid

helper, old_pid, protected_code = sys.argv[1], int(sys.argv[2]), sys.argv[3]
caller_birth = psutil.Process().create_time()
assert psutil.Process(old_pid).create_time() < caller_birth
try:
    psutil.Process(old_pid).environ()
except psutil.AccessDenied:
    pass
else:
    raise AssertionError('old fixture environment must be unreadable')
owner = str(uuid.uuid4())

def inspect():
    request = {'command': 'inspect', 'owner': owner, 'callerPid': os.getpid()}
    completed = subprocess.run([sys.executable, '-I', '-B', helper],
                               input=json.dumps(request), text=True, capture_output=True, timeout=10)
    return completed.returncode, json.loads(completed.stdout)

assert inspect() == (0, {'ok': True, 'identities': []})
env = {**os.environ, 'CODEMAP_SERENA_OWNER': owner}
new = subprocess.Popen([sys.executable, '-u', '-c', protected_code], env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
try:
    assert select.select([new.stdout], [], [], 5)[0], 'new fixture readiness timeout'
    assert new.stdout.readline().strip() == 'READY'
    assert psutil.Process(new.pid).create_time() >= caller_birth
    code, result = inspect()
    assert code == 1 and result == {'ok': False, 'error_type': 'AccessDenied'}
finally:
    new.kill()
    new.wait(timeout=5)
    new.stdout.close()
print('PASS')
"""


class FakeProcess:
    def __init__(self, pid=1234, uid=501, owner=OWNER, create_time=100.0):
        self.pid = pid
        self.uid = uid
        self.owner = owner
        self.birth = create_time
        self.signals = []
        self.environment_reads = 0

    def status(self):
        return psutil.STATUS_RUNNING

    def uids(self):
        return SimpleNamespace(real=self.uid)

    def create_time(self):
        return self.birth

    def environ(self):
        self.environment_reads += 1
        if isinstance(self.owner, Exception):
            raise self.owner
        return {module.OWNER_ENV: self.owner}

    def send_signal(self, number):
        self.signals.append(number)


class SerenaProcessTests(unittest.TestCase):
    def test_identity_probe_does_not_require_caller_identity(self):
        current = FakeProcess()
        identity = {"pid": current.pid, "uid": current.uid, "create_time": current.birth}
        output = io.StringIO()
        request = io.StringIO(json.dumps({"command": "identities", "identities": [identity]}))
        with patch.object(module.sys, "stdin", request), \
                patch.object(module.sys, "stdout", output), \
                patch.object(module, "caller_identity", side_effect=AssertionError("must not run")), \
                patch.object(module.psutil, "Process", return_value=current):
            self.assertEqual(module.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {"ok": True, "identities": [identity]})

    def test_signal_command_does_not_require_caller_but_checks_owner(self):
        current = FakeProcess()
        identity = {"pid": current.pid, "uid": current.uid, "create_time": current.birth}
        output = io.StringIO()
        request = io.StringIO(json.dumps({"command": "signal", "owner": OWNER,
                                         "identities": [identity], "signal": "TERM"}))
        with patch.object(module.sys, "stdin", request), \
                patch.object(module.sys, "stdout", output), \
                patch.object(module.os, "getuid", return_value=current.uid), \
                patch.object(module, "caller_identity", side_effect=AssertionError("must not run")), \
                patch.object(module.psutil, "Process", return_value=current):
            self.assertEqual(module.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {"ok": True, "identities": [identity]})
        self.assertEqual(current.signals, [module.signal.SIGTERM])

    def test_inspect_command_still_rejects_caller_change(self):
        output = io.StringIO()
        request = io.StringIO(json.dumps({"command": "inspect", "owner": OWNER, "callerPid": 4321}))
        with patch.object(module.sys, "stdin", request), \
                patch.object(module.sys, "stdout", output), \
                patch.object(module, "caller_identity", return_value={"pid": 4321, "create_time": 100}), \
                patch.object(module, "inspect_owned", return_value=[]), \
                patch.object(module, "confirm_caller", side_effect=RuntimeError("changed")):
            self.assertEqual(module.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {"ok": False, "error_type": "RuntimeError"})

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux PR_SET_DUMPABLE fixture")
    def test_real_older_protected_process_is_skipped_but_newer_one_fails(self):
        old = subprocess.Popen([sys.executable, "-u", "-c", PROTECTED_PROCESS],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            self.assertTrue(select.select([old.stdout], [], [], 5)[0], "old fixture readiness timeout")
            self.assertEqual(old.stdout.readline().strip(), "READY")
            # Linux /proc start-tick resolution may exceed the startup interval between adjacent processes.
            time.sleep(0.15)
            completed = subprocess.run([sys.executable, "-I", "-B", "-c", LINUX_CALLER,
                                        str(SCRIPT), str(old.pid), PROTECTED_PROCESS],
                                       capture_output=True, text=True, timeout=20)
            self.assertEqual(completed.returncode, 0, "Linux protected-process protocol fixture failed")
            self.assertEqual(completed.stdout.strip(), "PASS")
        finally:
            if old.poll() is None:
                old.kill()
            old.wait(timeout=5)
            old.stdout.close()

    def test_protocol_reports_only_allowlisted_type(self):
        output = io.StringIO()
        request = io.StringIO(json.dumps({"command": "inspect", "owner": OWNER, "callerPid": 4321}))
        with patch.object(module.sys, "stdin", request), \
                patch.object(module.sys, "stdout", output), \
                patch.object(module, "caller_identity", return_value={"create_time": 1}), \
                patch.object(module, "inspect_owned", side_effect=psutil.AccessDenied(pid=1234, name="PRIVATE_VALUE")):
            self.assertEqual(module.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {"ok": False, "error_type": "AccessDenied"})
        self.assertNotIn("PRIVATE_VALUE", output.getvalue())
        self.assertNotIn(OWNER, output.getvalue())

    def test_protocol_unknown_exception_is_normalized(self):
        class PrivateException(Exception):
            pass

        output = io.StringIO()
        request = io.StringIO(json.dumps({"command": "inspect", "owner": OWNER, "callerPid": 4321}))
        with patch.object(module.sys, "stdin", request), \
                patch.object(module.sys, "stdout", output), \
                patch.object(module, "caller_identity", return_value={"create_time": 1}), \
                patch.object(module, "inspect_owned", side_effect=PrivateException("PRIVATE_VALUE")):
            self.assertEqual(module.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {"ok": False, "error_type": "UnknownError"})
        self.assertNotIn("PRIVATE_VALUE", output.getvalue())

    def test_other_uid_ignored_before_environment_read(self):
        other = FakeProcess(uid=999)
        with patch.object(module.os, "getuid", return_value=501), \
                patch.object(module.psutil, "process_iter", return_value=[other]):
            self.assertEqual(module.inspect_owned(OWNER, 1), [])
        self.assertEqual(other.environment_reads, 0)

    def test_access_denied_does_not_become_empty_scan(self):
        current = FakeProcess(owner=psutil.AccessDenied(1234))
        with patch.object(module.os, "getuid", return_value=501), \
                patch.object(module.psutil, "process_iter", return_value=[current]):
            with self.assertRaises(psutil.AccessDenied):
                module.inspect_owned(OWNER, 1)

    def test_older_unreadable_environment_is_excluded_before_read(self):
        old = FakeProcess(owner=psutil.AccessDenied(1234), create_time=99)
        with patch.object(module.os, "getuid", return_value=501), \
                patch.object(module.sys, "platform", "linux"), \
                patch.object(module.psutil, "process_iter", return_value=[old]):
            self.assertEqual(module.inspect_owned(OWNER, 100), [])
        self.assertEqual(old.environment_reads, 0)

    def test_equal_or_newer_unreadable_environment_still_fails(self):
        for birth in (100, 101):
            current = FakeProcess(owner=psutil.AccessDenied(1234), create_time=birth)
            with patch.object(module.os, "getuid", return_value=501), \
                    patch.object(module.sys, "platform", "linux"), \
                    patch.object(module.psutil, "process_iter", return_value=[current]):
                with self.assertRaises(psutil.AccessDenied):
                    module.inspect_owned(OWNER, 100)
            self.assertEqual(current.environment_reads, 1)

    def test_macos_keeps_full_uid_scan(self):
        old = FakeProcess(owner=psutil.AccessDenied(1234), create_time=99)
        with patch.object(module.os, "getuid", return_value=501), \
                patch.object(module.sys, "platform", "darwin"), \
                patch.object(module.psutil, "process_iter", return_value=[old]):
            with self.assertRaises(psutil.AccessDenied):
                module.inspect_owned(OWNER, 100)
        self.assertEqual(old.environment_reads, 1)

    def test_caller_mismatch_or_changed_identity_rejected(self):
        parent = FakeProcess(pid=4321, create_time=100)
        with patch.object(module.os, "getppid", return_value=9999):
            with self.assertRaises(RuntimeError):
                module.caller_identity(4321)
        with patch.object(module.os, "getppid", return_value=4321), \
                patch.object(module.os, "getuid", return_value=501), \
                patch.object(module.psutil, "Process", return_value=parent):
            identity = module.caller_identity(4321)
            parent.birth += 1
            with self.assertRaises(RuntimeError):
                module.confirm_caller(identity)

    def test_signal_rechecks_owner_and_birth_before_sending(self):
        current = FakeProcess()
        identity = {"pid": current.pid, "uid": current.uid, "create_time": current.birth}
        with patch.object(module.os, "getuid", return_value=501), \
                patch.object(module.psutil, "Process", return_value=current):
            current.owner = "87654321-1234-1234-1234-123456789abc"
            with self.assertRaises(RuntimeError):
                module.signal_owned(OWNER, [identity], "KILL")
            current.owner = OWNER
            current.birth += 1
            self.assertEqual(module.signal_owned(OWNER, [identity], "KILL"), [])
            current.birth -= 1
            current.uid += 1
            with self.assertRaises(RuntimeError):
                module.signal_owned(OWNER, [identity], "KILL")
            current.uid -= 1
            self.assertEqual(module.signal_owned(OWNER, [identity], "TERM"), [identity])
        self.assertEqual(current.signals, [module.signal.SIGTERM])

    def test_signal_permission_error_propagates(self):
        current = FakeProcess()
        identity = {"pid": current.pid, "uid": current.uid, "create_time": current.birth}
        current.owner = psutil.AccessDenied(current.pid)
        with patch.object(module.os, "getuid", return_value=501), \
                patch.object(module.psutil, "Process", return_value=current):
            with self.assertRaises(psutil.AccessDenied):
                module.signal_owned(OWNER, [identity], "TERM")
        self.assertEqual(current.signals, [])


if __name__ == "__main__":
    unittest.main()
