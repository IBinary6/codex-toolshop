"""Regression: the catalog exporter must emit pure ASCII JSON regardless of the stdout code page.

Runs scripts/export-mcp-catalog.py against stub code_review_graph/mcp packages, so the real CRG is not needed.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "export-mcp-catalog.py"
DOC = "Find callers — fast. 中文 é \U0001f600"

STUBS = {
    "code_review_graph-0.0.1.dist-info/METADATA": "Metadata-Version: 2.1\nName: code-review-graph\nVersion: 0.0.1\n",
    "code_review_graph/__init__.py": "",
    "code_review_graph/main.py": f'''
import asyncio


class Dump:
    def __init__(self, data):
        self.data = data

    def model_dump(self, **_):
        return self.data

    def to_mcp_tool(self):
        return self

    def to_mcp_prompt(self):
        return self

    def to_mcp_resource(self):
        return self

    def to_mcp_template(self):
        return self


class Request:
    model_fields = {{"method": type("Field", (), {{"default": "tools/list"}})()}}


class Init:
    server_name = "stub"
    server_version = "0.0.1"
    instructions = {DOC!r}
    capabilities = Dump({{"tools": {{"listChanged": True}}}})


class Server:
    request_handlers = {{Request: None}}

    def create_initialization_options(self, **_):
        return Init()


class Mcp:
    _mcp_server = Server()

    async def list_tools(self):
        return [Dump({{"name": "t", "description": {DOC!r}}})]

    async def list_prompts(self):
        return []

    async def list_resources(self):
        return []

    async def list_resource_templates(self):
        return []


mcp = Mcp()
''',
    "mcp/__init__.py": "",
    "mcp/types.py": 'LATEST_PROTOCOL_VERSION = "2025-01-01"\n',
    "mcp/shared/__init__.py": "",
    "mcp/shared/version.py": 'SUPPORTED_PROTOCOL_VERSIONS = ["2025-01-01"]\n',
    "mcp/server/__init__.py": "",
    "mcp/server/lowlevel/__init__.py": "",
    "mcp/server/lowlevel/server.py": "class NotificationOptions:\n    def __init__(self, **_):\n        pass\n",
}


class ExporterEncodingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="export-catalog-test-")
        self.stubs = Path(self.temporary.name)
        for name, text in STUBS.items():
            target = self.stubs / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def run_exporter(self, **extra_env):
        env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
        env.update(PYTHONPATH=str(self.stubs), **extra_env)
        return subprocess.run([sys.executable, "-B", str(SCRIPT)], env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=60)

    def assert_round_trip(self, completed):
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        completed.stdout.decode("ascii")  # raises if any non-ASCII byte is present
        catalog = json.loads(completed.stdout.decode("ascii"))
        self.assertEqual(catalog["instructions"], DOC)
        self.assertEqual(catalog["tools"][0]["description"], DOC)
        self.assertEqual(catalog["version"], "0.0.1")

    def test_ascii_output_under_legacy_code_pages(self):
        # cp1252 and GBK are the Windows locale encodings that corrupted or rejected the em-dash; ascii is the strictest.
        for encoding in ("cp1252", "gbk", "ascii", "utf-8"):
            with self.subTest(encoding=encoding):
                self.assert_round_trip(self.run_exporter(PYTHONIOENCODING=encoding))

    def test_ascii_output_under_utf8_mode(self):
        self.assert_round_trip(self.run_exporter(PYTHONUTF8="1"))

    def test_dumps_catalog_is_ascii_and_lossless(self):
        sys.path.insert(0, str(self.stubs))
        meta_path = list(sys.meta_path)
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location("export_mcp_catalog_under_test", SCRIPT)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            payload = {"description": DOC, "nested": [DOC]}
            text = module.dumps_catalog(payload)
            text.encode("ascii")
            self.assertEqual(json.loads(text), payload)
            self.assertTrue(text.endswith("\n"))
        finally:
            sys.meta_path[:] = meta_path
            sys.path.remove(str(self.stubs))
            for name in [n for n in sys.modules if n.split(".")[0] in {"code_review_graph", "mcp"}]:
                del sys.modules[name]


if __name__ == "__main__":
    unittest.main()
