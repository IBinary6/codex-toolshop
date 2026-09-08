'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { findPython } = require('./launch.cjs');
const python = findPython();
if (!python) {
  process.stderr.write('Tests require Python 3.11+.\n');
  process.exitCode = 1;
} else {
  const result = spawnSync(python[0], [...python.slice(1), '-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
    cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  process.exitCode = result.status === 0 ? 0 : 1;
}
