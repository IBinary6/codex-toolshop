'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSerenaSession, cleanupSerenaSession, stopSerenaBackend } = require('../../../scripts/serena-server.cjs');

(async () => {
  {
    const events = [];
    let finish;
    const context = { exited: false, exit: new Promise(resolve => { finish = resolve; }),
      child: { serenaOwner: 'fixture-owner', stdin: { end() {
        events.push('EOF');
        setTimeout(() => { context.exited = true; events.push('exit'); finish(); }, 30);
      } } } };
    await stopSerenaBackend(context, { python: 'fixture-python' }, {
      platform: 'darwin', gracefulStopMs: 500,
      cleanupOwned: async (python, owner) => {
        assert.equal(python, 'fixture-python'); assert.equal(owner, 'fixture-owner');
        events.push('verify');
      },
      killTree: async () => { throw new Error('POSIX must not use CRG group killer'); },
    });
    assert.deepEqual(events, ['EOF', 'exit', 'verify'], 'normal delayed EOF gets a grace period before independent LSP verification');
    await assert.rejects(stopSerenaBackend({ ...context, exited: true }, { python: 'fixture-python' }, {
      platform: 'linux', cleanupOwned: async () => { throw new Error('identity unavailable'); },
    }), /identity unavailable/, 'successful root exit cannot hide failed LSP verification');
  }
  {
    const events = [];
    const child = { stdin: { end() { events.push('EOF'); } } };
    await stopSerenaBackend({ child, exited: false }, {}, { platform: 'win32',
      killTree: async (value) => { assert.equal(value, child); events.push('tree'); },
      cleanupOwned: async () => { throw new Error('POSIX scanner must not run on Windows'); },
    });
    assert.deepEqual(events, ['EOF', 'tree'], 'Windows retains live ChildProcess tree termination');
    await stopSerenaBackend({ child, exited: true }, {}, { platform: 'win32',
      killTree: async () => { throw new Error('cannot taskkill an exited PID'); },
    });
  }
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'serena-server-test-')));
  const source = path.join(data, 'serena-home');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'serena_config.yml'), 'projects: []\n');
  const options = { pluginDataDir: data, sessionCommand(request) {
    assert.equal(request.command, 'clone');
    assert.equal(request.source, source);
    assert.ok(path.dirname(request.home) === path.join(data, 'serena-sessions'));
    fs.mkdirSync(request.home);
    fs.copyFileSync(path.join(source, 'serena_config.yml'), path.join(request.home, 'serena_config.yml'));
    return { ok: true };
  } };
  try {
    const prepared = { env: { SERENA_HOME: source, KEEP: 'preserved' } };
    const first = await createSerenaSession(prepared, options);
    const second = await createSerenaSession({ env: { SERENA_HOME: source } }, options);
    assert.notEqual(first.home, second.home, 'each frontend owns a private UUID home');
    assert.equal(prepared.env.SERENA_HOME, first.home);
    assert.equal(prepared.env.KEEP, 'preserved');
    const stableResources = path.join(source, 'language_servers');
    fs.writeFileSync(path.join(stableResources, 'fixture-ls'), 'shared');
    assert.equal(fs.realpathSync(path.join(first.home, 'language_servers')), fs.realpathSync(stableResources));
    assert.equal(fs.realpathSync(path.join(second.home, 'language_servers')), fs.realpathSync(stableResources));
    cleanupSerenaSession(first, options);
    assert.ok(!fs.existsSync(first.home));
    assert.equal(fs.readFileSync(path.join(stableResources, 'fixture-ls'), 'utf8'), 'shared', 'cleanup never follows shared resource link');
    assert.equal(fs.readFileSync(path.join(second.home, 'language_servers', 'fixture-ls'), 'utf8'), 'shared');
    assert.throws(() => cleanupSerenaSession({ home: source }, options), /scope mismatch/);
    cleanupSerenaSession(second, options);
    const alias = path.join(data, 'data-alias');
    fs.symlinkSync(data, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasOptions = { ...options, pluginDataDir: alias };
    const aliased = await createSerenaSession({ env: { SERENA_HOME: source } }, aliasOptions);
    assert.equal(path.dirname(aliased.home), path.join(data, 'serena-sessions'), 'session ownership uses canonical data path');
    cleanupSerenaSession(aliased, aliasOptions);
    assert.ok(!fs.existsSync(aliased.home), 'data alias must not prevent own UUID cleanup');
    fs.unlinkSync(alias);

    const replaced = await createSerenaSession({ env: { SERENA_HOME: source } }, options);
    const saved = `${replaced.home}.saved`;
    fs.renameSync(replaced.home, saved);
    fs.symlinkSync(source, replaced.home, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => cleanupSerenaSession(replaced, options), /scope mismatch/, 'replaced UUID link must never be followed');
    assert.equal(fs.readFileSync(path.join(stableResources, 'fixture-ls'), 'utf8'), 'shared');
    fs.unlinkSync(replaced.home);
    fs.renameSync(saved, replaced.home);
    cleanupSerenaSession(replaced, options);
    assert.equal(fs.readFileSync(path.join(source, 'serena_config.yml'), 'utf8'), 'projects: []\n');
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
  console.log('serena_server.test.js PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
