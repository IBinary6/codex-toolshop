'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { findPython, pythonCandidates } = require('../hooks/js/run-python.js');

assert.deepStrictEqual(
  pythonCandidates({ platform: 'darwin', environment: {} }),
  [
    { command: 'python3', prefix: [] },
    { command: 'python', prefix: [] },
  ],
  'macOS should prefer python3'
);

assert.deepStrictEqual(
  pythonCandidates({ platform: 'win32', environment: {} }),
  [
    { command: 'python3', prefix: [] },
    { command: 'python', prefix: [] },
    { command: 'py', prefix: ['-3'] },
  ],
  'Windows should fall back to py -3'
);

assert.deepStrictEqual(
  pythonCandidates({
    platform: 'darwin',
    environment: { SYSTEM_PROXY_PYTHON: '/opt/custom/python3' },
  }),
  [{ command: '/opt/custom/python3', prefix: [] }],
  'Explicit Python paths should override discovery'
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
assert.ok(current, 'Tests require Python 3.10+');
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

// SessionStart child failures must report diagnostics rather than silently swallowing nonzero status.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-hook-failure-'));
try {
  fs.mkdirSync(path.join(temporary, 'scripts'));
  fs.writeFileSync(path.join(temporary, 'scripts', 'session_start.py'), 'raise SystemExit(7)\n');
  const failed = spawnSync(process.execPath, [runner, 'session_start'], {
    input: '{}', encoding: 'utf8',
    env: { ...process.env, PLUGIN_ROOT: temporary,
      PLUGIN_DATA: path.join(temporary, 'data'), CODEX_HOME: path.join(temporary, 'codex'),
      SYSTEM_PROXY_PYTHON: current.command, SYSTEM_PROXY_PYTHON_ARGS: current.prefix.join(' ') },
    windowsHide: process.platform === 'win32',
  });
  assert.equal(failed.status, 0, 'Failure diagnostics must not block the main task');
  assert.match(JSON.parse(failed.stdout).hookSpecificOutput.additionalContext, /exit code 7/);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('test_run_python.js PASS');
