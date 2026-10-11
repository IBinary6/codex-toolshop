'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  cachePath,
  pythonCandidates,
  resolvePython,
} = require('../scripts/python-launcher.cjs');
const { detectPython } = require('../hooks/js/local_knowledge_cli');

function result(version) {
  /** Construct a Python version probe result without starting a real process. */
  return { status: 0, stdout: `${version}\n`, stderr: '' };
}

const macCandidates = pythonCandidates({}, 'darwin');
const macCommands = macCandidates.map((candidate) => candidate.command);
assert.deepEqual(macCommands.slice(0, 2), ['python3', 'python']);
assert.ok(macCommands.includes('python3.12'), 'versioned interpreters are searched');
assert.ok(macCommands.includes('/opt/homebrew/bin/python3'), 'Homebrew is searched outside the GUI PATH');

const windowsCandidates = pythonCandidates({ APPDATA: path.join(os.tmpdir(), 'lk-missing-appdata') }, 'win32');
assert.deepEqual(windowsCandidates, [
  { command: 'python', args: [] },
  { command: 'python3', args: [] },
  { command: 'py', args: ['-3'] },
]);

// uv-managed interpreters are found newest first without starting uv.
const uvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-uv-'));
try {
  for (const name of ['cpython-3.11.9-linux-x86_64-gnu', 'cpython-3.13.1-linux-x86_64-gnu', 'pypy-3.10']) {
    fs.mkdirSync(path.join(uvRoot, name, 'bin'), { recursive: true });
  }
  const uvCommands = pythonCandidates({ UV_PYTHON_INSTALL_DIR: uvRoot, XDG_DATA_HOME: uvRoot }, 'linux')
    .map((candidate) => candidate.command).filter((command) => command.startsWith(uvRoot));
  assert.deepEqual(uvCommands.slice(0, 2), [
    path.join(uvRoot, 'cpython-3.13.1-linux-x86_64-gnu', 'bin', 'python3'),
    path.join(uvRoot, 'cpython-3.11.9-linux-x86_64-gnu', 'bin', 'python3'),
  ]);
} finally {
  fs.rmSync(uvRoot, { recursive: true, force: true });
}

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

// A verified interpreter is cached so later hooks pay for one probe instead of a full search.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-cache-'));
try {
  const cacheFile = path.join(cacheDir, 'python-runtime.json');
  const first = resolvePython({ cacheFile, environment: process.env });
  if (first.ok) {
    // Bare commands are returned as typed; the cache stores the absolute path they resolved to.
    const cachedEntry = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.ok(path.isAbsolute(cachedEntry.command), 'the cache stores an absolute interpreter path');
    assert.deepEqual(cachedEntry.args, first.args);
    const probes = [];
    const second = resolvePython({ cacheFile, environment: {}, platform: process.platform,
      spawnSyncImpl(command) { probes.push(command); return result(first.version); } });
    assert.equal(second.command, cachedEntry.command);
    assert.deepEqual(probes, [cachedEntry.command], 'cached interpreter is probed first and alone');
  }
} finally {
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

// The cache lives in the host-injected plugin data directory only; without it nothing is ever written.
assert.equal(cachePath({}), null, 'no PLUGIN_DATA: caching is off');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-data-'));
try {
  assert.equal(cachePath({ PLUGIN_DATA: dataDir }), path.join(dataDir, 'python-runtime.json'));
  const withData = resolvePython({ environment: { ...process.env, PLUGIN_DATA: dataDir } });
  if (withData.ok) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'python-runtime.json'), 'utf8')).command.length > 0, true,
      'a verified interpreter is cached in PLUGIN_DATA');
  }
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-nodata-'));
  const noData = { ...process.env }; delete noData.PLUGIN_DATA;
  resolvePython({ environment: noData, cacheFile: null });
  assert.deepEqual(fs.readdirSync(emptyDir), [], 'a disabled cache writes nothing');
  fs.rmSync(emptyDir, { recursive: true, force: true });
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const probeTimeouts = [];
resolvePython({ environment: {}, platform: 'linux', spawnSyncImpl(command, args, options) {
  probeTimeouts.push(options.timeout);
  return { status: 1 };
} });
assert.ok(probeTimeouts[0] >= 2500, 'each candidate gets enough time for a cold interpreter start');

console.log('python-launcher.test.js PASS');
