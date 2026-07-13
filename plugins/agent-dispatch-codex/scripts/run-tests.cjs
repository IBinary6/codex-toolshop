'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const tests = [
  'config.test.js',
  'agent_profiles.test.js',
  'shell.test.js',
  'guidance.test.js',
  'hooks.integration.test.js',
];
const testDir = path.resolve(__dirname, '..', 'hooks', 'js', '__tests__');

for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(testDir, test)], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    windowsHide: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status || 1);
  process.stdout.write(`${test} PASS\n`);
}

process.stdout.write('run-tests PASS\n');
