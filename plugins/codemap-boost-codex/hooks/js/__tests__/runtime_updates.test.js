'use strict';

const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crgRuntimePaths, ensureCrg } = require('../lib/bootstrap');
const { ensureSerena, serenaRuntimePaths } = require('../lib/serena-runtime');
const { main: runtimeUpdateMain } = require('../../../scripts/runtime-update.cjs');
const {
  WEEK_MS,
  adoptedUpdateLock,
  acquireUpdateLock,
  isUpdateDue,
  readUpdateState,
  runRuntimeUpdates,
  runtimeDir,
  runtimeUpdateDoctor,
  scheduleRuntimeUpdates,
  updateLockPath,
} = require('../lib/runtime-updates');
const {
  activeRuntimeVersion,
  compareVersions,
  promoteRuntimeVersion,
  readRuntimeVersions,
} = require('../lib/runtime-versions');

assert.strictEqual(WEEK_MS, 7 * 24 * 60 * 60 * 1000, '自动检查频率固定为七天');
assert.strictEqual(compareVersions('1.10.0', '1.9.9'), 1);
assert.strictEqual(compareVersions('1.7.0', '1.7.0'), 0);
assert.strictEqual(compareVersions('1.7.0', '1.7.1'), -1);
assert.strictEqual(isUpdateDue({ attempts: { crg: { at: 100 } } }, 'crg', 100 + WEEK_MS - 1, false), false);
assert.strictEqual(isUpdateDue({ attempts: { crg: { at: 100 } } }, 'crg', 100 + WEEK_MS, false), true);

async function main() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-runtime-updates-'));
  try {
    promoteRuntimeVersion('crg', '2.0.0', { pluginDataDir: data });
    promoteRuntimeVersion('serena', '1.7.0', { pluginDataDir: data });
    assert.strictEqual(activeRuntimeVersion('crg', { pluginDataDir: data }), '2.0.0');
    assert.strictEqual(crgRuntimePaths({ pluginDataDir: data }).dir, path.join(data, 'crg-runtimes', '2.0.0'));
    assert.strictEqual(serenaRuntimePaths({ pluginDataDir: data }).dir, path.join(data, 'serena-runtime', '1.7.0'));
    assert.strictEqual(crgRuntimePaths({ pluginDataDir: data, runtimeDir: path.join(data, 'check') }).dir, path.join(data, 'check'), '显式候选路径必须覆盖 active pointer');
    assert.ok(runtimeDir('crg', '2.1.0', { pluginDataDir: data }).startsWith(path.join(data, 'crg-runtimes')));

    let repaired = false;
    let crgProbeCount = 0;
    const selectedCrgDir = path.join(data, 'crg-runtimes', '2.0.0');
    assert.strictEqual(ensureCrg({
      pluginDataDir: data,
      markerPath: path.join(data, '.crg-install-failed'),
      probeRuntime: (options) => {
        assert.strictEqual(options.expectedVersion, '2.0.0', 'active runtime repair must require the selected version');
        assert.strictEqual(options.runtimeDir, selectedCrgDir, 'active pointer changes cannot redirect this repair venv');
        if (crgProbeCount++ === 0) promoteRuntimeVersion('crg', '2.1.0', { pluginDataDir: data });
        return repaired;
      },
      acquireInstallLock: () => 'lock-token', releaseInstallLock: () => {},
      installRuntime: (pkg, options) => {
        assert.strictEqual(pkg, 'code-review-graph[all]==2.0.0');
        assert.strictEqual(options.expectedVersion, '2.0.0');
        assert.strictEqual(options.version, '2.0.0');
        assert.strictEqual(options.runtimeDir, selectedCrgDir);
        repaired = true;
        return true;
      },
    }), true, 'active runtime repair remains pinned to its selected version');
    assert.strictEqual(activeRuntimeVersion('crg', { pluginDataDir: data }), '2.1.0', 'test actively changes pointer during repair');
    promoteRuntimeVersion('crg', '2.0.0', { pluginDataDir: data });

    promoteRuntimeVersion('serena', '1.7.0', { pluginDataDir: data });
    let serenaRepaired = false;
    let serenaProbeCount = 0;
    const selectedSerenaDir = path.join(data, 'serena-runtime', '1.7.0');
    assert.strictEqual(ensureSerena({
      pluginDataDir: data, markerPath: path.join(data, '.serena-install-failed'),
      probeRuntime: (options) => {
        assert.strictEqual(options.version, '1.7.0');
        assert.strictEqual(options.expectedVersion, '1.7.0');
        assert.strictEqual(options.runtimeDir, selectedSerenaDir);
        if (serenaProbeCount++ === 0) promoteRuntimeVersion('serena', '1.8.0', { pluginDataDir: data });
        return serenaRepaired;
      },
      acquireInstallLock: () => 'serena-lock', releaseInstallLock: () => {},
      installRuntime: (pkg, options) => {
        assert.strictEqual(pkg, 'serena-agent==1.7.0');
        assert.strictEqual(options.version, '1.7.0');
        assert.strictEqual(options.expectedVersion, '1.7.0');
        assert.strictEqual(options.runtimeDir, selectedSerenaDir);
        serenaRepaired = true;
        return true;
      },
    }), true, 'Serena repair retains its initially selected version and venv');
    assert.strictEqual(activeRuntimeVersion('serena', { pluginDataDir: data }), '1.8.0');
    promoteRuntimeVersion('serena', '1.7.0', { pluginDataDir: data });

    const installed = [];
    const first = await runRuntimeUpdates({
      pluginDataDir: data, force: true, now: () => 1000,
      fetchLatest: async (name) => name === 'code-review-graph' ? '2.1.0' : '1.8.0',
      installCrg: (pkg, opts) => { installed.push([pkg, opts.runtimeDir]); return true; },
      installSerena: (pkg, opts) => { installed.push([pkg, opts.runtimeDir]); return true; },
      probeCrg: (opts) => opts.expectedVersion === '2.1.0',
      probeSerena: (opts) => opts.expectedVersion === '1.8.0',
      checkCrgAdapter: (_paths, version) => ({ ok: version === '2.1.0' }),
      verifySerenaCli: () => true,
    });
    assert.strictEqual(first.status, 'ok');
    assert.deepStrictEqual(first.results.map((item) => item.status), ['promoted', 'promoted']);
    assert.strictEqual(activeRuntimeVersion('crg', { pluginDataDir: data }), '2.1.0');
    assert.strictEqual(activeRuntimeVersion('serena', { pluginDataDir: data }), '1.8.0');
    assert.deepStrictEqual(installed.map(([pkg]) => pkg), ['code-review-graph[all]==2.1.0', 'serena-agent==1.8.0']);
    assert.ok(installed.every(([_pkg, dir]) => /(?:crg-runtimes|serena-runtime)[\\/]\d/.test(dir)), '候选必须安装到独立 versioned venv');

    const beforeFailure = readRuntimeVersions({ pluginDataDir: data });
    const failed = await runRuntimeUpdates({
      pluginDataDir: data, force: true, now: () => 2000,
      fetchLatest: async (name) => name === 'code-review-graph' ? '2.2.0' : '1.9.0',
      installCrg: () => true, installSerena: () => true,
      probeCrg: () => false, probeSerena: () => false,
      checkCrgAdapter: () => ({ ok: false, reason: 'mock incompatible' }), verifySerenaCli: () => false,
    });
    assert.deepStrictEqual(failed.results.map((item) => item.status), ['failed', 'failed']);
    assert.deepStrictEqual(readRuntimeVersions({ pluginDataDir: data }), beforeFailure, '候选验证失败必须保留旧 pointer');
    const doctor = runtimeUpdateDoctor({ pluginDataDir: data });
    assert.strictEqual(doctor.runtimes.crg.selected, '2.1.0');
    assert.strictEqual(doctor.runtimes.crg.installed, null, 'doctor 不得把 pointer 当作实际安装版本');
    assert.strictEqual(doctor.runtimes.serena.installed, null);
    assert.strictEqual(doctor.attempts.crg.status, 'failed');
    assert.strictEqual(doctor.attempts.serena.status, 'failed');

    const beforeIncompatible = readRuntimeVersions({ pluginDataDir: data });
    const incompatible = await runRuntimeUpdates({
      pluginDataDir: data, force: true, now: () => 2500,
      fetchLatest: async (name) => name === 'code-review-graph' ? '2.2.0' : '1.9.0',
      installCrg: () => true, installSerena: () => true,
      probeCrg: () => true, probeSerena: () => true,
      checkCrgAdapter: () => ({ ok: false, reason: 'adapter contract rejected' }),
      verifySerenaCli: () => false,
    });
    assert.strictEqual(incompatible.status, 'partial', '任何候选验证失败必须让手动更新失败');
    assert.deepStrictEqual(incompatible.results.map((item) => item.status), ['failed', 'failed']);
    assert.match(incompatible.results[0].reason, /adapter contract rejected/);
    assert.deepStrictEqual(readRuntimeVersions({ pluginDataDir: data }), beforeIncompatible, 'adapter/CLI 拒绝不能切换 pointer');

    let cliOutput = '';
    const cliCode = await runtimeUpdateMain(['--check-now'], {
      updatesDisabled: () => false,
      runRuntimeUpdates: async () => ({ status: 'partial', results: [{ kind: 'crg', status: 'failed' }] }),
      write: (text) => { cliOutput += text; },
    });
    assert.strictEqual(cliCode, 1, '--check-now 必须把候选失败映射为非零退出码');
    assert.match(cliOutput, /"partial"/);

    const downgraded = await runRuntimeUpdates({
      pluginDataDir: data, force: true, now: () => 3000,
      fetchLatest: async (name) => name === 'code-review-graph' ? '2.0.0' : '1.7.0',
    });
    assert.deepStrictEqual(downgraded.results.map((item) => item.status), ['no-change', 'no-change'], '低版本候选不得降级');

    const lock = acquireUpdateLock({ pluginDataDir: data });
    assert.ok(lock, '首个更新器持有全任务锁');
    const busy = await runRuntimeUpdates({ pluginDataDir: data, force: true });
    assert.strictEqual(busy.status, 'busy', '并发更新不得重复安装');
    fs.rmSync(updateLockPath({ pluginDataDir: data }), { force: true });

    let launchOptions;
    let onChildError;
    const child = {
      pid: process.pid,
      once(event, listener) { if (event === 'error') onChildError = listener; },
      unref() {},
    };
    assert.strictEqual(scheduleRuntimeUpdates({
      pluginDataDir: data,
      now: () => WEEK_MS * 2,
      env: { EXTRA_TEST_ENV: 'yes' },
      spawn: (_command, _args, options) => { launchOptions = options; return child; },
    }), true);
    const scheduledLock = JSON.parse(fs.readFileSync(updateLockPath({ pluginDataDir: data }), 'utf8'));
    assert.strictEqual(scheduledLock.pid, process.pid, '调度锁必须移交给 updater 子进程 pid');
    assert.ok(adoptedUpdateLock(scheduledLock.token, { pluginDataDir: data }), '同 pid/token 的 updater 才能接管锁');
    assert.strictEqual(launchOptions.env.PLUGIN_DATA, path.resolve(data));
    assert.strictEqual(launchOptions.env.EXTRA_TEST_ENV, 'yes');
    onChildError(new Error('mock spawn failure'));
    assert.ok(!fs.existsSync(updateLockPath({ pluginDataDir: data })), '异步启动错误必须释放本次锁');
    assert.strictEqual(readUpdateState({ pluginDataDir: data }).scheduler.status, 'failed');

    const runtimeUpdates = path.resolve(__dirname, '../lib/runtime-updates.js');
    const missingExecutable = path.join(data, 'does-not-exist-runtime-updater');
    const childScript = [
      'const fs = require("fs");',
      'const { spawn } = require("child_process");',
      'const { scheduleRuntimeUpdates, readUpdateState, updateLockPath } = require(process.argv[1]);',
      `const data = ${JSON.stringify(data)};`,
      `const ok = scheduleRuntimeUpdates({ pluginDataDir: data, now: () => ${WEEK_MS * 3}, spawn: () => spawn(${JSON.stringify(missingExecutable)}, [], { stdio: 'ignore' }) });`,
      'if (ok) process.exit(10);',
      'setTimeout(() => {',
      '  const state = readUpdateState({ pluginDataDir: data });',
      '  if (fs.existsSync(updateLockPath({ pluginDataDir: data })) || !state.scheduler || state.scheduler.status !== "failed") process.exit(11);',
      '  process.exit(0);',
      '}, 100);',
    ].join('\n');
    const failedSpawn = spawnSync(process.execPath, ['-e', childScript, runtimeUpdates], {
      encoding: 'utf8', timeout: 5000, windowsHide: process.platform === 'win32',
    });
    assert.ifError(failedSpawn.error);
    assert.strictEqual(failedSpawn.status, 0, `missing updater executable must not crash MCP parent: ${failedSpawn.stderr}`);

    const disabled = await runRuntimeUpdates({ pluginDataDir: data, env: { CODEMAP_BOOST_DISABLE_RUNTIME_UPDATES: '1' } });
    assert.strictEqual(disabled.status, 'disabled');
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
  console.log('runtime_updates.test.js PASS');
}

main().catch((error) => { throw error; });
