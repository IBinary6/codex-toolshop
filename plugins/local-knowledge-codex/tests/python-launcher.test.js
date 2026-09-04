'use strict';

const assert = require('node:assert/strict');

const {
  pythonCandidates,
  resolvePython,
} = require('../scripts/python-launcher.cjs');
const { detectPython } = require('../hooks/js/local_knowledge_cli');

function result(version) {
  /** 构造不启动真实进程的 Python 版本探测结果。 */
  return { status: 0, stdout: `${version}\n`, stderr: '' };
}

const macCandidates = pythonCandidates({}, 'darwin');
assert.deepEqual(macCandidates.map((candidate) => candidate.command), ['python3', 'python']);

const windowsCandidates = pythonCandidates({}, 'win32');
assert.deepEqual(windowsCandidates, [
  { command: 'python', args: [] },
  { command: 'python3', args: [] },
  { command: 'py', args: ['-3'] },
]);

const configured = pythonCandidates({
  LOCAL_KNOWLEDGE_PYTHON: 'C:\\Program Files\\Python311\\python.exe',
}, 'win32');
assert.deepEqual(configured, [{
  command: 'C:\\Program Files\\Python311\\python.exe',
  args: [],
}]);

const calls = [];
const detected = detectPython({
  environment: {},
  platform: 'darwin',
  spawnSyncImpl(command) {
    calls.push(command);
    return command === 'python3' ? result('3.10.14') : result('3.12.7');
  },
});
assert.deepEqual(calls, ['python3', 'python']);
assert.equal(detected.ok, true);
assert.equal(detected.command, 'python');
assert.deepEqual(detected.args, []);
assert.equal(detected.version, '3.12.7');

const malformedThenSupported = resolvePython({
  environment: {},
  platform: 'win32',
  spawnSyncImpl(command) {
    if (command === 'python') return result('not-a-version');
    if (command === 'python3') return { status: 1, stdout: '', stderr: '' };
    return result('3.11.9');
  },
});
assert.equal(malformedThenSupported.ok, true);
assert.equal(malformedThenSupported.command, 'py');
assert.deepEqual(malformedThenSupported.args, ['-3']);

const unsupported = resolvePython({
  environment: {},
  platform: 'darwin',
  spawnSyncImpl(command) {
    return command === 'python3' ? result('3.10.13') : result('2.7.18');
  },
});
assert.equal(unsupported.ok, false);
assert.equal(unsupported.version, '3.10.13');

console.log('python-launcher.test.js PASS');
