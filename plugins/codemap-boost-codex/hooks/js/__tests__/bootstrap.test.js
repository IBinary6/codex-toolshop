'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  acquireInstallLock,
  crgRuntimePaths,
  ensureCli,
  ensureCrg,
  installManagedCrg,
  probeCrgRuntime,
  pythonCandidates,
  releaseInstallLock,
} = require('../lib/bootstrap');

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-stale-install-lock-'));
  const lock = path.join(tmp, 'runtime.install.lock');
  try {
    fs.writeFileSync(lock, '999999999', 'utf8');
    const old = new Date(Date.now() - 10000);
    fs.utimesSync(lock, old, old);
    const token = acquireInstallLock(lock, {
      installLockWaitMs: 200,
      installLockBootMs: 5000,
    });
    assert.ok(token, 'a dead installer lock is reclaimed after the boot grace period');
    releaseInstallLock(lock, token);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-live-install-lock-'));
  const lock = path.join(tmp, 'runtime.install.lock');
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'owner-token' }), 'utf8');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    assert.strictEqual(acquireInstallLock(lock, {
      installLockWaitMs: 20,
      installLockBootMs: 1,
    }), false, 'a live installer lock is never reclaimed only because it is old');
    releaseInstallLock(lock, 'another-token');
    assert.ok(fs.existsSync(lock), 'a non-owner cannot release the installation lock');
    releaseInstallLock(lock, 'owner-token');
    assert.ok(!fs.existsSync(lock), 'the matching owner token releases the installation lock');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  let installed = null;
  const ok = ensureCli('code-review-graph', 'code-review-graph[all]', '.unused', {
    probe: (cmd) => cmd === 'code-review-graph',
    install: (pkg) => { installed = pkg; return true; },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(installed, null, 'available CLI should not install');
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-bootstrap-'));
  let installed = null;
  try {
    const ok = ensureCli('graphify', 'graphifyy[all]', '.unused', {
      probe: () => false,
      install: (pkg) => { installed = pkg; return false; },
      markerPath: path.join(tmp, '.graphify-install-failed'),
    });
    assert.strictEqual(ok, false);
    assert.strictEqual(installed, 'graphifyy[all]', 'graphify command is installed from graphifyy package');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-managed-paths-'));
  try {
    const paths = crgRuntimePaths({ runtimeDir: tmp });
    assert.strictEqual(paths.dir, tmp);
    assert.ok(paths.python.startsWith(tmp), 'managed Python stays inside plugin data');
    assert.ok(paths.command.startsWith(tmp), 'managed CRG stays inside plugin data');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-managed-probe-'));
  const calls = [];
  try {
    const paths = crgRuntimePaths({ runtimeDir: tmp });
    const ok = probeCrgRuntime({
      runtimeDir: tmp,
      pathExists: () => true,
      spawnSync: (command, args) => {
        calls.push([command, args]);
        return { status: 0 };
      },
    });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(calls[0], [paths.command, ['--version']]);
    assert.strictEqual(calls[1][0], paths.python);
    assert.strictEqual(calls[1][1][0], '-I', 'parser probe matches CRG isolated interpreter mode');
    assert.match(calls[1][1][2], /get_parser/);
    assert.match(calls[1][1][2], /typescript/);
    assert.match(calls[1][1][2], /javascript/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  let calls = 0;
  assert.strictEqual(probeCrgRuntime({
    runtimeDir: path.join(os.tmpdir(), 'codemap-managed-broken-parser'),
    pathExists: () => true,
    spawnSync: () => ({ status: calls++ === 0 ? 0 : 1 }),
  }), false, 'CLI existence is insufficient when the isolated parser probe fails');
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-managed-uv-'));
  const calls = [];
  let runtimeExists = false;
  try {
    const paths = crgRuntimePaths({ runtimeDir: tmp });
    const ok = installManagedCrg('code-review-graph[all]', {
      runtimeDir: tmp,
      uvProbe: () => true,
      pathExists: () => runtimeExists,
      spawnSync: (command, args) => {
        calls.push([command, args]);
        if (command === 'uv' && args[0] === 'venv') runtimeExists = true;
        return { status: 0 };
      },
      probeRuntime: () => true,
    });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(calls[0], ['uv', ['venv', '--python', '3.12', tmp]]);
    assert.deepStrictEqual(calls[1], ['uv', ['pip', 'install', '--python', paths.python, '--upgrade', 'code-review-graph[all]']]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-managed-venv-'));
  const calls = [];
  let runtimeExists = false;
  try {
    const paths = crgRuntimePaths({ runtimeDir: tmp });
    const ok = installManagedCrg('code-review-graph[all]', {
      runtimeDir: tmp,
      uvProbe: () => false,
      pythonCandidates: () => [['custom-python', ['-3.12']]],
      pathExists: () => runtimeExists,
      spawnSync: (command, args) => {
        calls.push([command, args]);
        if (command === 'custom-python') runtimeExists = true;
        return { status: 0 };
      },
      probeRuntime: () => true,
    });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(calls[0], ['custom-python', ['-3.12', '-m', 'venv', tmp]]);
    assert.strictEqual(calls[1][0], paths.python);
    assert.deepStrictEqual(calls[1][1], ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'code-review-graph[all]']);
    assert.ok(!calls[1][1].includes('--user'), 'fallback never installs into user-site');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-managed-ensure-'));
  const marker = path.join(tmp, '.crg-install-failed');
  let healthy = false;
  let installed = 0;
  try {
    const ok = ensureCrg({
      runtimeDir: path.join(tmp, 'runtime'),
      markerPath: marker,
      probeRuntime: () => healthy,
      installRuntime: (pkg) => {
        installed += 1;
        assert.strictEqual(pkg, 'code-review-graph[all]');
        healthy = true;
        return true;
      },
    });
    assert.strictEqual(ok, true, 'unhealthy or user-site CLI is replaced by managed runtime');
    assert.strictEqual(installed, 1);
    assert.ok(!fs.existsSync(marker));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-managed-concurrent-'));
  let probes = 0;
  let installs = 0;
  let releases = 0;
  try {
    const ok = ensureCrg({
      runtimeDir: path.join(tmp, 'runtime'),
      markerPath: path.join(tmp, '.crg-install-failed'),
      probeRuntime: () => { probes += 1; return probes > 1; },
      installRuntime: () => { installs += 1; return true; },
      acquireInstallLock: () => true,
      releaseInstallLock: () => { releases += 1; },
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(installs, 0, 'a second task reuses the runtime installed by the lock holder');
    assert.strictEqual(releases, 1, 'the installation lock is always released');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-managed-fail-'));
  const marker = path.join(tmp, '.crg-install-failed');
  const diagnostics = [];
  try {
    const ok = ensureCrg({
      runtimeDir: path.join(tmp, 'runtime'),
      markerPath: marker,
      diagnostics,
      probeRuntime: () => { throw new Error('probe exploded'); },
      installRuntime: () => { throw new Error('install exploded'); },
    });
    assert.strictEqual(ok, false);
    assert.match(fs.readFileSync(marker, 'utf8'), /隔离运行环境/);
    assert.match(fs.readFileSync(marker, 'utf8'), /probe exploded/);
    assert.match(fs.readFileSync(marker, 'utf8'), /install exploded/);
    assert.match(fs.readFileSync(marker, 'utf8'), /user-site|setup/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-managed-diagnostics-'));
  const diagnostics = [];
  try {
    assert.strictEqual(installManagedCrg('code-review-graph[all]', {
      runtimeDir: tmp,
      diagnostics,
      uvProbe: () => true,
      pythonCandidates: () => [['fallback-python', []]],
      pathExists: () => false,
      spawnSync: () => ({ status: 1 }),
    }), false);
    assert.ok(diagnostics.some((entry) => /uv venv/.test(entry)), 'diagnostic records the failed uv stage');
    assert.ok(diagnostics.some((entry) => /fallback-python venv/.test(entry)), 'diagnostic records the failed Python fallback');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const oldPython = process.env.CODEMAP_BOOST_PYTHON;
  const oldArgs = process.env.CODEMAP_BOOST_PYTHON_ARGS;
  try {
    process.env.CODEMAP_BOOST_PYTHON = 'custom-python';
    process.env.CODEMAP_BOOST_PYTHON_ARGS = '-3.12 -Xutf8';
    assert.deepStrictEqual(pythonCandidates()[0], ['custom-python', ['-3.12', '-Xutf8']]);
  } finally {
    if (oldPython === undefined) delete process.env.CODEMAP_BOOST_PYTHON;
    else process.env.CODEMAP_BOOST_PYTHON = oldPython;
    if (oldArgs === undefined) delete process.env.CODEMAP_BOOST_PYTHON_ARGS;
    else process.env.CODEMAP_BOOST_PYTHON_ARGS = oldArgs;
  }
}

{
  const candidates = pythonCandidates().map(([command]) => command);
  assert.ok(candidates.includes('python3.12'), 'fallback probes an explicit Python 3.12 executable');
  assert.ok(candidates.includes('python3.11'), 'fallback probes an explicit Python 3.11 executable');
  assert.ok(candidates.indexOf('python3.12') < candidates.indexOf('python'), 'fallback prefers Python 3.12 before generic Python');
  assert.ok(candidates.indexOf('python3.11') < candidates.indexOf('python3'), 'fallback prefers Python 3.11 before generic Python 3');
}

console.log('bootstrap.test.js PASS');
