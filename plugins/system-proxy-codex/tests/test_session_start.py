import os
import tempfile
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PLUGIN_ROOT / "scripts"
if str(SCRIPTS_DIR) not in os.sys.path:
    os.sys.path.insert(0, str(SCRIPTS_DIR))

import session_start


class FakeCodex:
    def __init__(self, version="0.146.1", enabled=False):
        """Create a fake Codex client with observable feature calls."""

        self.version_value = version
        self.enabled = enabled
        self.enable_calls = 0
        self.feature_calls = 0

    def version(self):
        """Return the Codex version specified by the test."""

        return self.version_value

    def feature_enabled(self, name):
        """Record queries and return current feature state."""

        self.feature_calls += 1
        return self.enabled

    def enable_feature(self, name):
        """Record enable calls and update test state."""

        self.enable_calls += 1
        self.enabled = True


class SessionStartTest(unittest.TestCase):
    def test_first_start_enables_feature_and_records_state(self):
        """Verify first startup enables the feature and saves state."""

        with tempfile.TemporaryDirectory() as temp:
            client = FakeCodex()

            result = session_start.ensure_feature(client, Path(temp))

            self.assertTrue(result.changed)
            self.assertEqual(1, client.enable_calls)
            self.assertTrue((Path(temp) / "initialized.json").exists())

    def test_initialized_plugin_respects_later_manual_disable(self):
        """Verify manual feature disabling is respected after initialization."""

        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)
            data.joinpath("initialized.json").write_text("{}", encoding="utf-8")
            client = FakeCodex(enabled=False)

            result = session_start.ensure_feature(client, data)

            self.assertFalse(result.changed)
            self.assertEqual(0, client.feature_calls)
            self.assertEqual(0, client.enable_calls)

    def test_old_codex_is_rejected_without_marker(self):
        """Verify old Codex versions do not write success markers."""

        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(session_start.SessionStartError, "0.146.1"):
                session_start.ensure_feature(FakeCodex(version="0.145.0"), Path(temp))

    def test_concurrent_start_does_not_run_a_second_configuration(self):
        """Verify an active lock prevents concurrent Codex changes."""

        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)
            data.joinpath("initialize.lock").write_text("123", encoding="utf-8")
            client = FakeCodex()

            result = session_start.ensure_feature(client, data)

            self.assertFalse(result.changed)
            self.assertEqual(0, client.feature_calls)
            self.assertEqual(0, client.enable_calls)


if __name__ == "__main__":
    unittest.main()
