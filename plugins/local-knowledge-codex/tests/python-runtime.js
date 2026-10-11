'use strict';

const { spawnSync } = require('child_process');
const { resolvePython } = require('../scripts/python-launcher.cjs');

const TEST_ENV_NAMES = [
  'LOCAL_KNOWLEDGE_TEST_PYTHON',
  'BUGDB_TEST_PYTHON',
  'LOCAL_KNOWLEDGE_PYTHON',
  'BUGDB_PYTHON',
];
const runtime = resolvePython({ envNames: TEST_ENV_NAMES });
if (!runtime.ok) {
  const detail = runtime.version ? `; highest detected version is ${runtime.version}` : '';
  throw new Error(`Tests require Python 3.11+${detail}`);
}

function spawnPythonSync(args, options = {}) {
  /**
   * Run test subprocesses with the verified Python interpreter.
   *
   * Example: `spawnPythonSync(['-c', 'print(1)'])` does not rely on an unqualified `python` command.
   */
  return spawnSync(runtime.command, [...runtime.args, ...args], {
    ...options,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      ...(options.env || {}),
    },
    windowsHide: process.platform === 'win32',
  });
}

module.exports = { runtime, spawnPythonSync };
