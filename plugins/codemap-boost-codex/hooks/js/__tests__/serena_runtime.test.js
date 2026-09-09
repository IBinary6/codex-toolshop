'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MCP_BOOTSTRAP_BUDGET_MS,
} = require('../lib/bootstrap');
const {
  SERENA_MCP_ARGS,
  SERENA_PACKAGE,
  SERENA_VERSION,
  ensureSerena,
  probeSerenaRuntime,
  serenaFailureMarker,
  serenaHomeDir,
  serenaLaunchEnv,
  serenaRuntimePaths,
} = require('../lib/serena-runtime');
const { prepareSerenaServer } = require('../../../scripts/serena-server.cjs');

assert.strictEqual(SERENA_PACKAGE, 'serena-agent==1.7.0');
assert.strictEqual(SERENA_VERSION, '1.7.0');
assert.deepStrictEqual(SERENA_MCP_ARGS, [
  'start-mcp-server', '--context', 'codex',
  '--enable-web-dashboard', 'false',
  '--open-web-dashboard', 'false',
  '--enable-gui-log-window', 'false',
]);
assert.ok(!SERENA_MCP_ARGS.includes('--project-from-cwd'), 'plugin-root cwd must never activate a project automatically');

const win = serenaRuntimePaths({ platform: 'win32', pluginDataDir: 'C:\\plugin-data' });
assert.strictEqual(win.dir, 'C:\\plugin-data\\serena-runtime\\1.7.0');
assert.strictEqual(win.python, 'C:\\plugin-data\\serena-runtime\\1.7.0\\Scripts\\python.exe');
assert.strictEqual(win.command, 'C:\\plugin-data\\serena-runtime\\1.7.0\\Scripts\\serena.exe');
const posix = serenaRuntimePaths({ platform: 'linux', pluginDataDir: '/plugin-data' });
assert.strictEqual(posix.dir, '/plugin-data/serena-runtime/1.7.0');
assert.strictEqual(posix.command, '/plugin-data/serena-runtime/1.7.0/bin/serena');
assert.ok(!posix.dir.includes('crg-runtime'), 'Serena must not share the CRG runtime');

const isolated = serenaLaunchEnv({ platform: 'linux', pluginDataDir: '/plugin-data', env: { SERENA_HOME: '/user-home', KEEP: 'yes' } });
assert.strictEqual(isolated.SERENA_HOME, '/plugin-data/serena-home', 'private SERENA_HOME overrides user state');
assert.strictEqual(isolated.KEEP, 'yes');
assert.strictEqual(serenaHomeDir({ platform: 'linux', pluginDataDir: '/plugin-data' }), '/plugin-data/serena-home');

{
  let calls = 0;
  const ok = probeSerenaRuntime({
    platform: 'linux', pluginDataDir: '/probe', pathExists: () => true,
    env: { SERENA_HOME: '/wrong' },
    spawnSync(command, args, options) {
      calls += 1;
      assert.strictEqual(command, '/probe/serena-runtime/1.7.0/bin/python');
      assert.deepStrictEqual(args.slice(0, 3), ['-I', '-B', '-c']);
      assert.match(args[3], /version\('serena-agent'\) == '1\.7\.0'/);
      assert.match(args[3], /from serena\.cli import top_level/);
      assert.strictEqual(options.env.SERENA_HOME, '/probe/serena-home');
      return { status: 0 };
    },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(calls, 1);
}

{
  let spawned = false;
  const diagnostics = [];
  assert.strictEqual(probeSerenaRuntime({
    platform: 'linux', pluginDataDir: '/expired', pathExists: () => true,
    deadlineMs: 10, now: () => 10, diagnostics,
    spawnSync() { spawned = true; return { status: 0 }; },
  }), false);
  assert.strictEqual(spawned, false, 'expired shared budget must not start a probe');
  assert.match(diagnostics.join('\n'), /预算已耗尽/);
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serena-runtime-'));
  try {
    let installDeadline = 0;
    let probeCalls = 0;
    const ok = ensureSerena({
      pluginDataDir: tmp,
      now: () => 100,
      probeRuntime() { return ++probeCalls >= 3; },
      acquireInstallLock() { return 'token'; },
      releaseInstallLock() {},
      installRuntime(pkg, options) {
        assert.strictEqual(pkg, SERENA_PACKAGE);
        installDeadline = options.deadlineMs;
        assert.ok(options.runtimeDir.endsWith(path.join('serena-runtime', '1.7.0')));
        return true;
      },
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(installDeadline, 100 + MCP_BOOTSTRAP_BUDGET_MS);

    const failed = ensureSerena({
      pluginDataDir: tmp,
      probeRuntime: () => false,
      acquireInstallLock: () => null,
    });
    assert.strictEqual(failed, false);
    assert.ok(fs.existsSync(serenaFailureMarker({ pluginDataDir: tmp })), 'lock failure writes only the private marker');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const prepared = prepareSerenaServer({
    nodeRuntimeStatus: () => ({ ok: true }),
    ensureSerena: () => true,
    serenaRuntimePaths: () => ({ command: '/private/serena' }),
    serenaLaunchEnv: () => ({ SERENA_HOME: '/private/home' }),
  });
  assert.strictEqual(prepared.ok, true);
  assert.strictEqual(prepared.command, '/private/serena');
  assert.deepStrictEqual(prepared.args, SERENA_MCP_ARGS);
  assert.strictEqual(prepared.env.SERENA_HOME, '/private/home');
  assert.strictEqual(prepareSerenaServer({ nodeRuntimeStatus: () => ({ ok: false, version: '16', requirement: '>=18.0.0' }) }).ok, false);
}

console.log('serena_runtime.test.js PASS');
