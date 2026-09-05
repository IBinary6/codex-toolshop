'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const tests = [
  'guidance.test.js',
  'app_server.test.js',
  'naming.test.js',
  'first_prompt.test.js',
  'startup_observer.test.js',
  'hooks.integration.test.js',
  'desktop_delivery.test.js',
];
const testDirectory = path.resolve(__dirname, '..', 'hooks', 'js', '__tests__');

/**
 * 逐个执行 Node 测试，保留稳定顺序和原始失败码。
 *
 * @returns {void}
 * @example
 * main();
 */
function main() {
  for (const test of tests) {
    const result = spawnSync(process.execPath, [path.join(testDirectory, test)], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      windowsHide: process.platform === 'win32',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
    process.stdout.write(`${test} PASS\n`);
  }
  process.stdout.write('run-tests PASS\n');
}

main();
