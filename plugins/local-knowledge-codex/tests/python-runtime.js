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
  const detail = runtime.version ? `，最高检测版本为 ${runtime.version}` : '';
  throw new Error(`测试需要 Python 3.11+${detail}`);
}

function spawnPythonSync(args, options = {}) {
  /**
   * 使用已验证的 Python 运行测试子进程。
   *
   * Example: `spawnPythonSync(['-c', 'print(1)'])` 不依赖裸 `python` 命令。
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
