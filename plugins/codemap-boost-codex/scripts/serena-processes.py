"""Inspect and stop only processes with the specified Serena backend ownership marker.

Read the marker from stdin and omit it from diagnostics; use the private Serena runtime containing psutil.
"""

import json
import os
import re
import signal
import sys

try:
    import psutil
except Exception as error:
    # During import, return only allowed error types; never write interpreter exception text to stderr.
    error_type = type(error).__name__
    if error_type not in {"ModuleNotFoundError", "ImportError", "OSError"}:
        error_type = "UnknownError"
    json.dump({"ok": False, "error_type": error_type}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(1)


OWNER_ENV = "CODEMAP_SERENA_OWNER"
OWNER_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
GONE = (psutil.NoSuchProcess, psutil.ZombieProcess)
SAFE_ERROR_TYPES = frozenset({
    "AccessDenied", "NoSuchProcess", "ZombieProcess", "RuntimeError",
    "ValueError", "PermissionError", "ProcessLookupError", "TimeoutError",
    "OSError", "FileNotFoundError", "NotImplementedError", "TypeError",
    "AttributeError", "KeyError", "JSONDecodeError", "KeyboardInterrupt",
    "ModuleNotFoundError", "ImportError",
})


def valid_owner(owner):
    return isinstance(owner, str) and bool(OWNER_PATTERN.fullmatch(owner))


def current_identity(process, expected_uid=None):
    """Return live process identity, or None for vanished processes and zombies."""
    try:
        if process.status() == psutil.STATUS_ZOMBIE:
            return None
        uid = process.uids().real if os.name == "posix" else None
        if expected_uid is not None and uid != expected_uid:
            return None
        identity = {"pid": process.pid, "create_time": process.create_time()}
        if uid is not None:
            identity["uid"] = uid
        return identity
    except GONE:
        return None


def caller_identity(caller_pid):
    """Trust only the actual direct parent OS identity, never an orphan replacement parent."""
    if type(caller_pid) is not int or caller_pid <= 0 or os.getppid() != caller_pid:
        raise RuntimeError("caller identity unavailable")
    identity = current_identity(psutil.Process(caller_pid))
    if identity is None or (os.name == "posix" and identity.get("uid") != os.getuid()):
        raise RuntimeError("caller identity unavailable")
    if os.getppid() != caller_pid:
        raise RuntimeError("caller identity changed")
    return identity


def confirm_caller(expected):
    if os.getppid() != expected["pid"] or current_identity(psutil.Process(expected["pid"])) != expected:
        raise RuntimeError("caller identity changed")


def inspect_owned(owner, earliest_create_time):
    """On Linux exclude candidates older than the caller; generate owner after caller startup."""
    if os.name != "posix":
        raise ValueError("unsupported platform")
    if not valid_owner(owner):
        raise ValueError("invalid owner")
    uid = os.getuid()
    found = []
    for process in psutil.process_iter():
        if sys.platform.startswith("linux"):
            try:
                # Linux boot time plus /proc start ticks provides ordering;
                # older processes cannot inherit this random owner; exclude them before reading environ.
                if process.create_time() < earliest_create_time:
                    continue
            except GONE:
                continue
        identity = current_identity(process)
        if identity is None or identity["uid"] != uid:
            continue
        try:
            if process.environ().get(OWNER_ENV) == owner:
                # Recheck identity on the same process object before returning.
                fresh = current_identity(process, uid)
                if fresh is not None and fresh == identity:
                    found.append(fresh)
        except GONE:
            continue
    return sorted(found, key=lambda item: (item["pid"], item["create_time"]))


def matching_identity(process, expected, owner):
    fresh = current_identity(process)
    if fresh is None or fresh["create_time"] != expected["create_time"]:
        return False
    if fresh != expected:
        raise RuntimeError("process identity changed")
    try:
        if process.environ().get(OWNER_ENV) != owner:
            raise RuntimeError("process ownership changed")
        after = current_identity(process)
        if after is None or after["create_time"] != expected["create_time"]:
            return False
        if after != expected:
            raise RuntimeError("process identity changed")
        return True
    except GONE:
        return False


def signal_owned(owner, identities, signal_name):
    if os.name != "posix" or not valid_owner(owner):
        raise ValueError("invalid request")
    number = {"TERM": signal.SIGTERM, "KILL": signal.SIGKILL}.get(signal_name)
    if number is None or not isinstance(identities, list):
        raise ValueError("invalid request")
    sent = []
    for expected in identities:
        if not valid_identity(expected, require_uid=True):
            raise ValueError("invalid identity")
        try:
            process = psutil.Process(expected["pid"])
            if not matching_identity(process, expected, owner):
                continue
            try:
                process.send_signal(number)
            except GONE:
                continue
            # A vanished target is acceptable; a live identity change must fail conservatively.
            after = current_identity(psutil.Process(expected["pid"]))
            if after is not None and after != expected:
                raise RuntimeError("process identity changed during signal")
            sent.append(expected)
        except GONE:
            continue
    return sent


def valid_identity(identity, require_uid=False):
    if not isinstance(identity, dict):
        return False
    if type(identity.get("pid")) is not int or identity["pid"] <= 0:
        return False
    if type(identity.get("create_time")) not in (int, float) or identity["create_time"] <= 0:
        return False
    if require_uid and (type(identity.get("uid")) is not int or identity["uid"] != os.getuid()):
        return False
    return True


def inspect_identities(identities):
    if not isinstance(identities, list):
        raise ValueError("invalid identities")
    alive = []
    for expected in identities:
        if not valid_identity(expected):
            raise ValueError("invalid identity")
        try:
            current = current_identity(psutil.Process(expected["pid"]))
        except GONE:
            continue
        if current is not None and current["create_time"] == expected["create_time"]:
            if "uid" not in expected or current.get("uid") == expected["uid"]:
                alive.append(current)
    return alive


def main():
    try:
        request = json.load(sys.stdin)
        command = request.get("command")
        if command == "inspect":
            caller = caller_identity(request.get("callerPid"))
            result = inspect_owned(request.get("owner"), caller["create_time"])
            confirm_caller(caller)
        elif command == "signal":
            result = signal_owned(request.get("owner"), request.get("identities"), request.get("signal"))
        elif command == "identities":
            result = inspect_identities(request.get("identities"))
        else:
            raise ValueError("invalid command")
        json.dump({"ok": True, "identities": result}, sys.stdout)
        sys.stdout.write("\n")
    except (Exception, KeyboardInterrupt) as error:
        # Request values and potentially sensitive psutil exception text never leave the helper.
        error_type = type(error).__name__
        if error_type not in SAFE_ERROR_TYPES:
            error_type = "UnknownError"
        json.dump({"ok": False, "error_type": error_type}, sys.stdout)
        sys.stdout.write("\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
