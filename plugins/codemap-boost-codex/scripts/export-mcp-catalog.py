"""Export real CRG registration metadata without entering main, warmup, or model-loading paths."""

import asyncio
import importlib.abc
import json
import sys
from importlib.metadata import version


class NoModelImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in {"torch", "sentence_transformers", "transformers"}:
            raise RuntimeError(f"catalog export attempted model import: {fullname}")
        return None


sys.meta_path.insert(0, NoModelImports())
from code_review_graph.main import mcp  # noqa: E402
from mcp.types import LATEST_PROTOCOL_VERSION  # noqa: E402
from mcp.shared.version import SUPPORTED_PROTOCOL_VERSIONS  # noqa: E402
from mcp.server.lowlevel.server import NotificationOptions  # noqa: E402


def wire(value):
    return value.model_dump(mode="json", by_alias=True, exclude_none=True)


async def export():
    # Match the actual FastMCP stdio transport rather than generic LowLevelServer defaults.
    init = mcp._mcp_server.create_initialization_options(
        notification_options=NotificationOptions(tools_changed=True)
    )
    return {
        "format": 2,
        "version": version("code-review-graph"),
        "protocolVersion": LATEST_PROTOCOL_VERSION,
        "supportedProtocolVersions": SUPPORTED_PROTOCOL_VERSIONS,
        "requestMethods": sorted(
            request_type.model_fields["method"].default
            for request_type in mcp._mcp_server.request_handlers
        ),
        "serverInfo": {"name": init.server_name, "version": init.server_version},
        "instructions": init.instructions,
        "capabilities": wire(init.capabilities),
        "tools": [wire(tool.to_mcp_tool()) for tool in await mcp.list_tools()],
        "prompts": [wire(prompt.to_mcp_prompt()) for prompt in await mcp.list_prompts()],
        "resources": [wire(resource.to_mcp_resource()) for resource in await mcp.list_resources()],
        "resourceTemplates": [wire(template.to_mcp_template()) for template in await mcp.list_resource_templates()],
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(export()), ensure_ascii=False, indent=2))
