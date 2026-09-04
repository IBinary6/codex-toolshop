'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { findPython, pythonCandidates } = require('../hooks/js/run-python.js');

assert.deepStrictEqual(
  pythonCandidates({ platform: 'darwin', environment: {} }),
  [
    { command: 'python3', prefix: [] },
    { command: 'python', prefix: [] },
  ],
  'macOS 应优先使用 python3'
);

assert.deepStrictEqual(
  pythonCandidates({ platform: 'win32', environment: {} }),
  [
    { command: 'python3', prefix: [] },
    { command: 'python', prefix: [] },
    { command: 'py', prefix: ['-3'] },
  ],
  'Windows 应回退到 py -3'
);

assert.deepStrictEqual(
  pythonCandidates({
    platform: 'darwin',
    environment: { SYSTEM_PROXY_PYTHON: '/opt/custom/python3' },
  }),
  [{ command: '/opt/custom/python3', prefix: [] }],
  '显式 Python 路径应覆盖自动探测'
);

const attempts = [];
const selected = findPython({
  candidates: [
    { command: 'python', prefix: [] },
    { command: 'python3', prefix: [] },
  ],
  spawnSync(command) {
    attempts.push(command);
    if (command === 'python') {
      return { status: 0, stdout: 'Python 3.9.18\n', stderr: '' };
    }
    return { status: 0, stdout: 'Python 3.12.8\n', stderr: '' };
  },
});

assert.deepStrictEqual(selected, { command: 'python3', prefix: [] });
assert.deepStrictEqual(attempts, ['python', 'python3']);

const current = findPython();
assert.ok(current, '测试环境需要 Python 3.10+');
const runner = path.resolve(__dirname, '..', 'hooks', 'js', 'run-python.js');
const propagated = spawnSync(process.execPath, [runner, '--exec', '-c', 'import sys; sys.exit(7)'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    SYSTEM_PROXY_PYTHON: current.command,
    SYSTEM_PROXY_PYTHON_ARGS: current.prefix.join(' '),
  },
  windowsHide: process.platform === 'win32',
});
assert.equal(propagated.status, 7, propagated.stderr);

console.log('test_run_python.js PASS');
