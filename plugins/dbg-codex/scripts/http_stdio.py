"""用官方 MCP SDK 将本机原生 HTTP 扩展接入插件的固定 stdio 入口。"""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import timedelta
import sys

import anyio
from mcp import ClientSession, types
from mcp.client.streamable_http import streamablehttp_client
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from dbg_core import default_data_dir, load_json
from managed_server import select_http_runtime


@asynccontextmanager
async def remote_session(runtime):
    headers = {}
    if runtime.get("token"):
        headers["Authorization"] = "Bearer " + runtime["token"]
    async with streamablehttp_client(runtime["url"], headers=headers, timeout=timedelta(seconds=30)) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def main():
    tool = sys.argv[1]
    server = Server("dbg-" + tool)
    status_name = "dbg_" + tool.replace("-", "_") + "_status"

    def runtime():
        return select_http_runtime(load_json(default_data_dir() / "state.json", default={}), tool)

    @server.list_tools()
    async def list_tools():
        status = types.Tool(name=status_name, description="检查调试器 HTTP MCP 是否已启动", inputSchema={"type": "object", "properties": {}})
        try:
            async with remote_session(runtime()) as session:
                result = await session.list_tools()
                return [status, *result.tools]
        except Exception:
            return [status]

    @server.call_tool()
    async def call_tool(name, arguments):
        try:
            async with remote_session(runtime()) as session:
                if name == status_name:
                    result = await session.list_tools()
                    return [types.TextContent(type="text", text=f"已连接，后端暴露 {len(result.tools)} 个工具。")]
                result = await session.call_tool(name, arguments or {})
                # 保留上游错误标记和结构化内容，不能把后端错误降格为成功文本。
                return result
        except Exception:
            return types.CallToolResult(isError=True, content=[types.TextContent(
                type="text", text="调试器 MCP 当前不可连接。请打开已部署扩展的调试器；若刚执行 doctor，在新任务中重新加载工具列表。")])

    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    anyio.run(main)
