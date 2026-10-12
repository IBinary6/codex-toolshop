"""The local_knowledge package uses bugdb's public names only, never a private helper."""

import ast
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent / "local_knowledge"


class PackageBoundaryTest(unittest.TestCase):
    def test_no_import_of_private_names(self):
        offenders = []
        for source in sorted(PACKAGE.glob("*.py")):
            for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
                if isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "bugdb":
                    for alias in node.names:
                        if alias.name.startswith("_"):
                            offenders.append(f"{source.name}:{node.lineno} imports private {alias.name} from {node.module}")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
