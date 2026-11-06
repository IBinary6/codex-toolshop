"""Own one stdio session's subprocesses without inspecting or ending other debugger sessions."""
from __future__ import annotations

from contextlib import closing
import ctypes
from ctypes import wintypes
import os
import select
import signal
import subprocess
import sys
import threading


class ProcessOwnershipError(RuntimeError):
    """A session cannot start a backend if its process tree cannot be contained."""


class _BasicJobLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
    ]


class _ExtendedJobLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicJobLimits), ("IoInfo", ctypes.c_uint64 * 6),
        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _windows_owner(parent_pid):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    def api(name, result, *parameters):
        function = getattr(kernel, name)
        function.restype = result
        function.argtypes = parameters
        return function

    handle, boolean, dword = wintypes.HANDLE, wintypes.BOOL, wintypes.DWORD
    filetime = ctypes.POINTER(wintypes.FILETIME)
    current = api("GetCurrentProcess", handle)()
    open_process = api("OpenProcess", handle, dword, boolean, dword)
    close = api("CloseHandle", boolean, handle)
    wait = api("WaitForSingleObject", dword, handle, dword)
    get_times = api("GetProcessTimes", boolean, handle, filetime, filetime, filetime, filetime)
    create_job = api("CreateJobObjectW", handle, ctypes.c_void_p, wintypes.LPCWSTR)
    set_job = api("SetInformationJobObject", boolean, handle, ctypes.c_int, ctypes.c_void_p, dword)
    assign = api("AssignProcessToJobObject", boolean, handle, handle)

    def checked(function, *arguments):
        result = function(*arguments)
        if not result:
            detail = ctypes.WinError(ctypes.get_last_error())
            raise ProcessOwnershipError(f"Cannot establish MCP process ownership ({function.__name__}): {detail}")
        return result

    def creation_time(process):
        times = [wintypes.FILETIME() for _ in range(4)]
        checked(get_times, process, *(ctypes.byref(value) for value in times))
        return (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime

    parent = checked(open_process, 0x100000 | 0x1000, False, parent_pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    try:
        if creation_time(parent) > creation_time(current) or wait(parent, 0) != 258:  # WAIT_TIMEOUT
            raise ProcessOwnershipError("MCP launcher has already exited")
        job = checked(create_job, None, None)  # 独占且不可继承，后端无法延长 Job 生命周期。
        try:
            limits = _ExtendedJobLimits()
            limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            checked(set_job, job, 9, ctypes.byref(limits), ctypes.sizeof(limits))  # JobObjectExtendedLimitInformation
            # 先把 supervisor 本身放进 Job，再创建后端，避免后端抢先启动孙进程。
            checked(assign, job, current)
        except BaseException:
            close(job)
            raise
    except BaseException:
        close(parent)
        raise

    def wait_for_parent():
        try:
            wait(parent, 0xFFFFFFFF)  # INFINITE。若等待异常，按所有权丢失处理。
        finally:
            close(parent)

    # Job 也包含 supervisor。留给系统在本进程退出时关闭句柄，可保留后端退出码。
    return wait_for_parent


def _wait_posix_exit(pid):
    """等待子进程退出，暂不回收 PID，进程组清理完成后再由 Popen.wait 回收。"""
    if hasattr(os, "waitid"):
        os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
        return
    # macOS 的 Python 没有 os.waitid，使用 kqueue 监视同一个未回收的子进程。
    event = select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                          fflags=select.KQ_NOTE_EXIT)
    with closing(select.kqueue()) as queue:
        try:
            queue.control([event], 0, 0)
        except ProcessLookupError:
            return  # 子进程在注册退出通知前已经退出。
        queue.control(None, 1)


def _posix_parent_alive(parent, direct_parent):
    if os.getppid() != direct_parent:
        return False
    if parent != direct_parent:
        try:
            os.kill(parent, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass
    return True


class ProcessOwner:
    """MCP launcher 是控制进程，后端及其后代只归当前 Python supervisor 所有。"""

    def __init__(self):
        self._closed = threading.Event()
        self._interrupted = threading.Event()
        self._lock = threading.Lock()
        self._group = None
        direct_parent = os.getppid()
        try:
            parent = int(os.environ.get("DBG_MCP_OWNER_PID", direct_parent))
            if not 0 < parent <= 0xFFFFFFFF or parent == os.getpid():
                raise ValueError("invalid owner PID")
            if os.name == "nt":
                wait_for_parent = _windows_owner(parent)
            else:
                if not _posix_parent_alive(parent, direct_parent):
                    raise ProcessOwnershipError("MCP launcher has already exited")
                # 无显式 owner 的普通脚本调用依旧监视自己的直接父进程。
                wait_for_parent = lambda: self._wait_posix_parent(parent, direct_parent)
                for name in (signal.SIGINT, signal.SIGTERM):
                    signal.signal(name, self._interrupt)
        except (ValueError, OSError) as error:
            raise ProcessOwnershipError(f"Cannot establish MCP process ownership: {error}") from error
        threading.Thread(target=self._watch_parent, args=(wait_for_parent,), daemon=True).start()

    def _interrupt(self, _signum, _frame):
        self._interrupted.set()

    def _wait_posix_parent(self, parent, direct_parent):
        while not self._closed.is_set() and not self._interrupted.wait(0.1):
            if not _posix_parent_alive(parent, direct_parent):
                return

    def _watch_parent(self, wait_for_parent):
        wait_for_parent()
        self._interrupted.set()
        if self._closed.wait(0.5):  # 先给 stdin EOF 的正常退出留出时间。
            return
        self.close()
        os._exit(1)  # 避免阻塞的 stdin 或解释器清理延迟操作系统回收 Job。

    def start(self, command, environment):
        with self._lock:
            if self._closed.is_set() or self._interrupted.is_set():
                raise ProcessOwnershipError("MCP launcher is shutting down")
            process = subprocess.Popen(command, env=environment, stdin=sys.stdin, stdout=sys.stdout,
                                       stderr=sys.stderr,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                                       start_new_session=os.name != "nt")
            if os.name != "nt":
                self._group = process.pid
            return process

    def wait(self, process):
        if os.name != "nt":
            # 先观察退出，再清理进程组，最后回收组长 PID，避免用已释放的 PGID 发信号。
            _wait_posix_exit(process.pid)
            self.close()
        return process.wait()

    def close(self):
        with self._lock:
            if self._group is not None:
                try:
                    os.killpg(self._group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self._group = None
            self._closed.set()
