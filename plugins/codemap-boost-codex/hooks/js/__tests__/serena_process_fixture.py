"""Independent session process tree for serena_processes.test.js."""

import os
import signal
import subprocess
import sys
import time


CHILD = r'''
import signal
import time
import sys
mode = sys.argv[1]
if mode == "stubborn":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
elif mode == "delayed":
    def later(*_):
        time.sleep(0.25)
        sys.exit(0)
    signal.signal(signal.SIGTERM, later)
print("READY", flush=True)
while True:
    time.sleep(0.1)
'''


def start_child(mode):
    child = subprocess.Popen(
        [sys.executable, "-u", "-c", CHILD, mode],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        env=os.environ.copy(),
    )
    # Expose the PID only after the child installs its signal handler, so the test cannot send SIGTERM too early.
    if child.stdout.readline() != b"READY\n":
        raise RuntimeError("child did not become ready")
    child.stdout.close()
    return child.pid


mode = sys.argv[1]
if mode == "early":
    print(start_child(sys.argv[2]), flush=True)
elif mode == "eof":
    sys.stdin.read()
    print(start_child(sys.argv[2]), flush=True)
elif mode == "live":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    print(start_child(sys.argv[2]), flush=True)
    while True:
        time.sleep(0.1)
elif mode == "term_spawn":
    first = start_child(sys.argv[2])

    def spawn_on_term(*_):
        print(start_child("stubborn"), flush=True)
        sys.exit(0)

    signal.signal(signal.SIGTERM, spawn_on_term)
    print(first, flush=True)
    while True:
        time.sleep(0.1)
