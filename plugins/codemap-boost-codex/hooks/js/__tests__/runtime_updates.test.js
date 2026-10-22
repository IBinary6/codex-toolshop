'use strict';

const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crgRuntimePaths, ensureCrg } = require('../lib/bootstrap');
const { SERENA_VERSION, ensureSerena, serenaRuntimePaths } = require('../lib/serena-runtime');
const { main: runtimeUpdateMain } = require('../../../scripts/runtime-update.cjs');
const {
  WEEK_MS,
  adoptedUpdateLock,
  acquireUpdateLock,
  isUpdateDue,
  pruneRuntimeVersions,
  readUpdateState,
  runRuntimeUpdates,
  runtimeDir,
  runtimeUpdateDoctor,
  scheduleRuntimeUpdates,
  updateLockPath,
  verifySerenaCli,
} = require('../lib/runtime-updates');
const {
  activeRuntimeVersion,
  compareVersions,
  promoteRuntimeVersion,
  readRuntimeVersions,
} = require('../lib/runtime-versions');

assert.strictEqual(WEEK_MS, 7 * 24 * 60 * 60 * 1000, 'Automatic checks are fixed at seven days');
assert.strictEqual(compareVersions('1.10.0', '1.9.9'), 1);
assert.strictEqual(compareVersions('1.7.0', '1.7.0'), 0);
assert.strictEqual(compareVersions('1.7.0', '1.7.1'), -1);
assert.strictEqual(isUpdateDue({ attempts: { crg: { at: 100 } } }, 'crg', 100 + WEEK_MS - 1, false), false);
assert.strictEqual(isUpdateDue({ attempts: { crg: { at: 100 } } }, 'crg', 100 + WEEK_MS, false), true);

async function main() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-runtime-updates-'));
  try {
    const stableHome = path.join(data, 'serena-home');
    fs.mkdirSync(stableHome);
    const stableConfig = path.join(stableHome, 'serena_config.yml');
    const originalConfig = 'projects: []\nls_specific_settings: {}\n';
    fs.writeFileSync(stableConfig, originalConfig);
    for (const status of [0, 1]) {
      let probeHome;
      assert.strictEqual(verifySerenaCli({ python: 'candidate-python', dir: data }, {
        pluginDataDir: data,
        spawnSync: (_command, _args, options) => {
          probeHome = options.env.SERENA_HOME;
          assert.notStrictEqual(probeHome, stableHome);
          assert.strictEqual(options.cwd, probeHome);
          assert.strictEqual(fs.readFileSync(path.join(probeHome, 'serena_config.yml'), 'utf8'), originalConfig,
            'the candidate is checked with the agent interface the user configured, not a fresh template');
          fs.writeFileSync(path.join(probeHome, 'serena_config.yml'), 'candidate defaults');
          return { status };
        },
      }), status === 0);
      assert.strictEqual(fs.existsSync(probeHome), false, 'Clean the candidate probe directory after success or failure');
      assert.strictEqual(fs.readFileSync(stableConfig, 'utf8'), originalConfig);
      assert.deepStrictEqual(fs.readdirSync(stableHome), ['serena_config.yml'], 'A candidate must not add logs or default directories to stable HOME');
    }
    promoteRuntimeVersion('crg', '2.0.0', { pluginDataDir: data });
    promoteRuntimeVersion('serena', '1.7.0', { pluginDataDir: data });
    assert.strictEqual(activeRuntimeVersion('crg', { pluginDataDir: data }), '2.0.0');
    assert.strictEqual(crgRuntimePaths({ pluginDataDir: data }).dir, path.join(data, 'crg-runtimes', '2.0.0'));
    assert.strictEqual(serenaRuntimePaths({ pluginDataDir: data }).dir, path.join(data, 'serena-runtime', '1.7.0'));
    assert.strictEqual(crgRuntimePaths({ pluginDataDir: data, runtimeDir: path.join(data, 'check') }).dir, path.join(data, 'check'), 'An explicit candidate path must override the active pointer');
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
      checkCrgCatalog: (_paths, version) => version === '2.1.0',
      verifySerenaCli: () => true,
    });
    assert.strictEqual(first.status, 'ok');
    assert.deepStrictEqual(first.results.map((item) => item.status), ['promoted', 'promoted']);
    assert.strictEqual(activeRuntimeVersion('crg', { pluginDataDir: data }), '2.1.0');
    assert.strictEqual(activeRuntimeVersion('serena', { pluginDataDir: data }), '1.8.0');
    assert.deepStrictEqual(installed.map(([pkg]) => pkg), ['code-review-graph[all]==2.1.0', 'serena-agent==1.8.0']);
    assert.ok(installed.every(([_pkg, dir]) => /(?:crg-runtimes|serena-runtime)[\\/]\d/.test(dir)), 'Candidates must install into separate versioned venvs');

    const beforeFailure = readRuntimeVersions({ pluginDataDir: data });
    const failed = await runRuntimeUpdates({
      pluginDataDir: data, force: true, now: () => 2000,
      fetchLatest: async (name) => name === 'code-review-graph' ? '2.2.0' : '1.9.0',
      installCrg: () => true, installSerena: () => true,
      probeCrg: () => false, probeSerena: () => false,
      checkCrgAdapter: () => ({ ok: false, reason: 'mock incompatible' }), verifySerenaCli: () => false,
    });
    assert.deepStrictEqual(failed.results.map((item) => item.status), ['failed', 'failed']);
    assert.deepStrictEqual(readRuntimeVersions({ pluginDataDir: data }), beforeFailure, 'A failed candidate validation must preserve the old pointer');
    const doctor = runtimeUpdateDoctor({ pluginDataDir: data });
    assert.strictEqual(doctor.runtimes.crg.selected, '2.1.0');
    assert.strictEqual(doctor.runtimes.crg.installed, null, 'Doctor must not treat the pointer as an installed version');
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
    assert.strictEqual(incompatible.status, 'partial', 'Any candidate validation failure must fail manual update');
    assert.deepStrictEqual(incompatible.results.map((item) => item.status), ['failed', 'failed']);
    assert.match(incompatible.results[0].reason, /adapter contract rejected/);
    assert.deepStrictEqual(readRuntimeVersions({ pluginDataDir: data }), beforeIncompatible, 'Adapter/CLI rejection must not switch the pointer');

    const catalogRejected = await runRuntimeUpdates({
      pluginDataDir: data, force: true, kinds: ['crg'], now: () => 2600,
      fetchLatest: async () => '2.2.0', installCrg: () => true, probeCrg: () => true,
      checkCrgAdapter: () => ({ ok: true }), checkCrgCatalog: async () => { throw new Error('schema export rejected'); },
    });
    assert.strictEqual(catalogRejected.status, 'partial');
    assert.match(catalogRejected.results[0].reason, /schema export rejected/);
    assert.deepStrictEqual(readRuntimeVersions({ pluginDataDir: data }), beforeIncompatible, 'Catalog failure must not promote a candidate');

    const onlySerena = await runRuntimeUpdates({
      pluginDataDir: data, force: true, kinds: ['serena'], now: () => 2700,
      fetchLatest: async (name) => { assert.strictEqual(name, 'serena-agent'); return '1.8.0'; },
      currentCrgVersion: () => { throw new Error('CRG must remain cold'); },
      installCrg: () => { throw new Error('CRG must remain cold'); },
    });
    assert.deepStrictEqual(onlySerena.results.map((item) => item.kind), ['serena']);

    let cliOutput = '';
    const cliCode = await runtimeUpdateMain(['--check-now'], {
      updatesDisabled: () => false,
      runRuntimeUpdates: async () => ({ status: 'partial', results: [{ kind: 'crg', status: 'failed' }] }),
      write: (text) => { cliOutput += text; },
    });
    assert.strictEqual(cliCode, 1, '--check-now must return nonzero on candidate failure');
    assert.match(cliOutput, /"partial"/);

    const downgraded = await runRuntimeUpdates({
      pluginDataDir: data, force: true, now: () => 3000,
      fetchLatest: async (name) => name === 'code-review-graph' ? '2.0.0' : '1.7.0',
    });
    assert.deepStrictEqual(downgraded.results.map((item) => item.status), ['no-change', 'no-change'], 'An older candidate must not downgrade the runtime');

    const lock = acquireUpdateLock({ pluginDataDir: data });
    assert.ok(lock, 'The first updater owns the task-wide lock');
    const busy = await runRuntimeUpdates({ pluginDataDir: data, force: true });
    assert.strictEqual(busy.status, 'busy', 'Concurrent updates must not duplicate installation');
    fs.rmSync(updateLockPath({ pluginDataDir: data }), { force: true });

    let launchOptions, launchArgs;
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
      kinds: ['serena'],
      spawn: (_command, args, options) => { launchArgs = args; launchOptions = options; return child; },
    }), true);
    const scheduledLock = JSON.parse(fs.readFileSync(updateLockPath({ pluginDataDir: data }), 'utf8'));
    assert.strictEqual(scheduledLock.pid, process.pid, 'The scheduling lock must transfer to the updater child PID');
    assert.ok(adoptedUpdateLock(scheduledLock.token, { pluginDataDir: data }), 'Only an updater with the same PID and token can adopt the lock');
    assert.strictEqual(launchOptions.env.PLUGIN_DATA, path.resolve(data));
    assert.strictEqual(launchOptions.env.EXTRA_TEST_ENV, 'yes');
    assert.deepStrictEqual(launchArgs.slice(-2), ['--kinds', 'serena'], 'Background scheduling must not silently include CRG');
    onChildError(new Error('mock spawn failure'));
    assert.ok(!fs.existsSync(updateLockPath({ pluginDataDir: data })), 'An asynchronous startup error must release this lock');
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

    // Pruning keeps the active venv, the one it replaced (running sessions may still use it) and the Serena baseline.
    const pruneData = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-runtime-prune-'));
    try {
      const venv = (kind, version) => fs.mkdirSync(runtimeDir(kind, version, { pluginDataDir: pruneData }), { recursive: true });
      for (const version of ['2.0.0', '2.1.0', '2.2.0']) venv('crg', version);
      for (const version of [SERENA_VERSION, '1.8.0', '1.9.0', '2.0.0']) venv('serena', version);
      fs.mkdirSync(path.join(pruneData, 'crg-runtime'), { recursive: true });
      promoteRuntimeVersion('crg', '2.1.0', { pluginDataDir: pruneData });
      promoteRuntimeVersion('crg', '2.2.0', { pluginDataDir: pruneData });
      promoteRuntimeVersion('serena', '1.9.0', { pluginDataDir: pruneData });
      promoteRuntimeVersion('serena', '2.0.0', { pluginDataDir: pruneData });
      assert.deepStrictEqual(readRuntimeVersions({ pluginDataDir: pruneData }).previous, { crg: '2.1.0', serena: '1.9.0' }, 'promotion remembers the replaced version');
      assert.deepStrictEqual(pruneRuntimeVersions('crg', { pluginDataDir: pruneData }), ['2.0.0']);
      assert.deepStrictEqual(fs.readdirSync(path.join(pruneData, 'crg-runtimes')).sort(), ['2.1.0', '2.2.0']);
      assert.ok(fs.existsSync(path.join(pruneData, 'crg-runtime')), 'the legacy CRG baseline is never removed');
      assert.deepStrictEqual(pruneRuntimeVersions('serena', { pluginDataDir: pruneData }), ['1.8.0']);
      assert.deepStrictEqual(fs.readdirSync(path.join(pruneData, 'serena-runtime')).sort(), [SERENA_VERSION, '1.9.0', '2.0.0'].sort());

      // A candidate that fails validation is removed instead of staying on disk.
      const rejected = await runRuntimeUpdates({
        pluginDataDir: pruneData, force: true, kinds: ['serena'],
        fetchLatest: async () => '2.1.0',
        installSerena: (_pkg, installOptions) => { fs.mkdirSync(installOptions.runtimeDir, { recursive: true }); return true; },
        probeSerena: () => true, verifySerenaCli: () => false,
      });
      assert.strictEqual(rejected.results[0].status, 'failed');
      assert.strictEqual(fs.existsSync(runtimeDir('serena', '2.1.0', { pluginDataDir: pruneData })), false, 'the rejected candidate venv is removed');
      assert.strictEqual(readRuntimeVersions({ pluginDataDir: pruneData }).active.serena, '2.0.0', 'the current runtime stays');
    } finally {
      fs.rmSync(pruneData, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
  console.log('runtime_updates.test.js PASS');
}

main().catch((error) => { throw error; });
