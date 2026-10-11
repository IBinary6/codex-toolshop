const assert = require('node:assert');

const {
  PYTHON_PROBE_TIMEOUT_MS,
  pythonCandidates,
  resetPythonCacheForTests,
  resolvePython,
} = require('../lib/python');

// Return immediately when the first candidate is Python 3, avoiding extra interpreter starts.
{
  let calls = 0;
  const resolved = resolvePython({
    platform: 'darwin',
    env: {},
    spawnSync: () => { calls += 1; return { status: 0 }; },
  });
  assert.deepStrictEqual(resolved, { cmd: 'python3', args: [] });
  assert.strictEqual(calls, 1);
}

// macOS: continue probing after an absent first command instead of stopping on ENOENT.
{
  const calls = [];
  const resolved = resolvePython({
    platform: 'darwin',
    env: {},
    spawnSync: (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'python3') return { error: Object.assign(new Error('missing'), { code: 'ENOENT' }), status: null };
      return { status: 0 };
    },
  });
  assert.deepStrictEqual(resolved, { cmd: 'python', args: [] });
  assert.deepStrictEqual(calls.map((call) => call.cmd), ['python3', 'python']);
  assert.ok(calls.every((call) => call.args.includes('-c')), 'Python probing runs version validation code');
}

// Continue probing after a non-Python-3 executable to avoid using Python 2.
{
  const resolved = resolvePython({
    platform: 'darwin',
    env: {},
    spawnSync: (cmd) => ({ status: cmd === 'python3' ? 1 : 0 }),
  });
  assert.deepStrictEqual(resolved, { cmd: 'python', args: [] });
}

// Windows Python Launcher accepts any available Python 3 instead of pinning 3.11.
{
  const candidates = pythonCandidates({ platform: 'win32', env: {} });
  assert.deepStrictEqual(candidates[0], { cmd: 'py', args: ['-3'] });
  assert.ok(!candidates.some((candidate) => candidate.args.includes('-3.11')));

  const resolved = resolvePython({
    platform: 'win32',
    env: {},
    spawnSync: (cmd, args) => ({ status: cmd === 'py' && args[0] === '-3' ? 0 : 1 }),
  });
  assert.deepStrictEqual(resolved, { cmd: 'py', args: ['-3'] });
}

// Cache default runtime probes to avoid restarting Python candidates for each staged file.
{
  resetPythonCacheForTests();
  let calls = 0;
  const options = {
    platform: 'darwin',
    env: {},
    useCache: true,
    spawnSync: (_cmd, _args, spawnOptions) => {
      calls += 1;
      assert.strictEqual(spawnOptions.timeout, PYTHON_PROBE_TIMEOUT_MS);
      return { status: 0 };
    },
  };
  assert.deepStrictEqual(resolvePython(options), { cmd: 'python3', args: [] });
  assert.deepStrictEqual(resolvePython(options), { cmd: 'python3', args: [] });
  assert.strictEqual(calls, 1);
  resetPythonCacheForTests();
}

console.log('python.test.js PASS');
