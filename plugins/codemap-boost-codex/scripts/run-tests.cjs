'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testsDir = path.join(__dirname, '..', 'hooks', 'js', '__tests__');

function main() {
  const tests = fs.readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.js'))
    .sort();
  for (const name of tests) {
    const file = path.join(testsDir, name);
    const result = spawnSync(process.execPath, [file], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      windowsHide: process.platform === 'win32',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
  console.log('run-tests PASS');
}

main();
