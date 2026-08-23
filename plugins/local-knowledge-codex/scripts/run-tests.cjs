'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');

function main() {
  const tests = fs.readdirSync(testsDir).filter((name) => name.endsWith('.test.js')).sort();
  for (const name of tests) {
    const result = spawnSync(process.execPath, [path.join(testsDir, name)], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'inherit',
      windowsHide: process.platform === 'win32',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
  process.stdout.write('run-tests PASS\n');
}

main();
