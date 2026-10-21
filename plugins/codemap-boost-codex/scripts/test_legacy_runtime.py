"""Legacy CRG must fail before opening any graph; the JS selector owns migration."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('adapter', Path(__file__).with_name('refresh_graph.py'))
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)


class LegacyRuntimeTest(unittest.TestCase):
    def test_missing_scoped_parser_requires_migration(self):
        from importlib.metadata import version
        self.assertEqual(version('code-review-graph'), '2.3.7')
        with self.assertRaisesRegex(RuntimeError, 'requires CRG >= 2.3.8'):
            ADAPTER.check_runtime()


if __name__ == '__main__':
    unittest.main()
