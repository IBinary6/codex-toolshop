"""Smoke-test the deployed Ghidra MCP stdio protocol without a GUI."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import signal
import sys
import tempfile


TIMEOUT_SECONDS = 30


def deployed_runtime() -> tuple[Path, list[str], dict[str, str]]:
    configured = os.environ.get("DBG_HOME")
    if not configured:
        raise RuntimeError("Smoke test requires isolated DBG_HOME")
    home = Path(configured).expanduser().resolve()
    state = json.loads((home / "state.json").read_text(encoding="utf-8"))
    record = state.get("tools", {}).get("ghidra", {})
    if record.get("status") != "deployed":
        raise RuntimeError("Ghidra has not deployed successfully; cannot run the MCP smoke test")
    runtime = record.get("runtime", {})
    command = runtime.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(x, str) for x in command):
        raise RuntimeError("Ghidra state lacks a valid MCP launch command")
    if not Path(command[0]).is_file():
        raise RuntimeError("Ghidra MCP runtime interpreter does not exist")
    extra_env = runtime.get("env", {})
    if not isinstance(extra_env, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in extra_env.items()
    ):
        raise RuntimeError("Ghidra MCP runtime environment has invalid format")
    return home, command, extra_env


async def send(process: asyncio.subprocess.Process, payload: dict) -> None:
    assert process.stdin is not None
    process.stdin.write((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
    await process.stdin.drain()


async def response(process: asyncio.subprocess.Process, request_id: int) -> dict:
    assert process.stdout is not None
    deadline = asyncio.get_running_loop().time() + TIMEOUT_SECONDS
    for _ in range(100):
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            break
        line = await asyncio.wait_for(process.stdout.readline(), timeout=remaining)
        if not line:
            raise RuntimeError(f"MCP exited before request {request_id} returned")
        message = json.loads(line)
        if message.get("id") != request_id:
            continue
        if "error" in message:
            raise RuntimeError(f"MCP request {request_id} returned an error: {message['error']}")
        if not isinstance(message.get("result"), dict):
            raise RuntimeError(f"MCP request {request_id} lacks a result object")
        return message["result"]
    raise RuntimeError(f"MCP request {request_id} timed out or returned too many unrelated messages")


async def stop_owned_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    if os.name == "nt":
        process.terminate()
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        await asyncio.wait_for(process.wait(), timeout=3)
    except asyncio.TimeoutError:
        if os.name == "nt":
            process.kill()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        await process.wait()


async def smoke() -> None:
    home, command, extra_env = deployed_runtime()
    with tempfile.TemporaryFile() as diagnostics:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=home,
            env={**os.environ, **extra_env},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=diagnostics,
            limit=1024 * 1024,
            start_new_session=os.name != "nt",
        )
        try:
            await send(process, {
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "dbg-ghidra-ci-smoke", "version": "1"},
                },
            })
            initialized = await response(process, 1)
            if not isinstance(initialized.get("serverInfo"), dict):
                raise RuntimeError("MCP initialize did not return serverInfo")
            await send(process, {"jsonrpc": "2.0", "method": "notifications/initialized"})
            await send(process, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
            listed = await response(process, 2)
            tools = listed.get("tools")
            if not isinstance(tools, list) or not tools:
                raise RuntimeError("Ghidra MCP tools/list returned no tools")
            assert process.stdin is not None
            process.stdin.close()
            await asyncio.wait_for(process.wait(), timeout=TIMEOUT_SECONDS)
            if process.returncode != 0:
                raise RuntimeError(f"Ghidra MCP exit code after stdin EOF was {process.returncode}")
            print(f"Ghidra MCP stdio initialize, tools/list ({len(tools)} tools), and EOF exit passed; GUI backend was not verified")
        except Exception as exc:
            await stop_owned_process(process)
            diagnostics.seek(0)
            detail = diagnostics.read().decode("utf-8", errors="replace")[-2000:]
            raise RuntimeError(f"Ghidra MCP smoke test failed: {exc}\n{detail}") from exc
        finally:
            await stop_owned_process(process)


if __name__ == "__main__":
    try:
        asyncio.run(smoke())
    except Exception as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1)
