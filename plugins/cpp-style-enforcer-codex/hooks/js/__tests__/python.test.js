const assert = require('node:assert');

const {
  PYTHON_PROBE_TIMEOUT_MS,
  pythonCandidates,
  resetPythonCacheForTests,
  resolvePython,
} = require('../lib/python');

// 首个候选已经是 Python 3 时应立即返回，避免每次 cpplint 重复启动其他解释器。
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

// macOS：第一个命令不存在时必须继续探测 python，不能因 ENOENT 提前中止。
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
  assert.ok(calls.every((call) => call.args.includes('-c')), 'Python 探测必须执行版本校验代码');
}

// 可执行文件存在但不是 Python 3 时必须继续探测，避免误用 Python 2。
{
  const resolved = resolvePython({
    platform: 'darwin',
    env: {},
    spawnSync: (cmd) => ({ status: cmd === 'python3' ? 1 : 0 }),
  });
  assert.deepStrictEqual(resolved, { cmd: 'python', args: [] });
}

// Windows Python Launcher 应选择任意可用 Python 3，而不是绑定单一 3.11 小版本。
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

// 默认运行路径应缓存探测结果，避免每个暂存文件重复启动 Python 候选。
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
