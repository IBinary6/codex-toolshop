'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const api = require('../lib/plugin-updates');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-updates-test-'));
const options = { codexHome: home, env: {} };
try {
  assert.strictEqual(api.INTERVAL_MS, 604800000, 'update cadence is one week');
  assert(!api.due({ lastAttemptAt: 10 }, 10 + api.INTERVAL_MS - 1));
  assert(api.due({ lastAttemptAt: 10 }, 10 + api.INTERVAL_MS));
  assert.deepStrictEqual(api.readState(options), {}, 'doctor does not create state');
  assert(!fs.existsSync(path.join(home, 'plugins')));
  assert(!api.schedulePluginUpdate({ ...options, pluginRoot: path.join(home, 'source') }));
  const pluginRoot = path.join(home, 'plugins/cache/codex-toolshop/codemap-boost-codex/0.1.31');
  let launches = 0;
  const scheduled = { ...options, pluginRoot, now: 100, spawn(command, args, opts) {
    launches++;
    assert.strictEqual(command, process.execPath);
    assert.strictEqual(args[1], '--scheduled');
    assert(opts.detached && opts.windowsHide && opts.stdio === 'ignore');
    const child = new EventEmitter(); child.unref = () => {}; return child;
  } };
  assert(api.schedulePluginUpdate(scheduled));
  assert(!api.schedulePluginUpdate(scheduled));
  assert.strictEqual(launches, 1, 'multiple task starts share the same weekly state');
  assert(!api.schedulePluginUpdate({ ...scheduled, now: api.INTERVAL_MS * 2, env: { CODEX_TOOLSHOP_DISABLE_PLUGIN_UPDATES: '1' } }));

  const market = path.join(home, 'marketplace');
  const manifest = path.join(market, 'plugins/codemap-boost-codex/.codex-plugin/plugin.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ name: 'codemap-boost-codex', version: '0.1.31' }));
  const source = { name: 'codex-toolshop', root: market, marketplaceSource: { sourceType: 'git', source: 'https://github.com/IBinary6/codex-toolshop.git' } };
  let installed = [
    { name: 'codemap-boost-codex', version: '0.1.30', installed: true, enabled: true },
    { name: 'other-disabled', version: '0.1.0', installed: true, enabled: false },
  ];
  const calls = [];
  const runCodex = args => {
    calls.push(args);
    if (args[1] === 'marketplace' && args[2] === 'list') return { status: 0, stdout: JSON.stringify({ marketplaces: [source] }) };
    if (args[1] === 'marketplace' && args[2] === 'upgrade') return { status: 0, stdout: '{}' };
    if (args[1] === 'add') { installed[0] = { ...installed[0], version: '0.1.31' }; return { status: 0, stdout: '{}' }; }
    return { status: 0, stdout: JSON.stringify({ installed, available: [] }) };
  };
  const success = api.checkPluginUpdates({ ...options, runCodex });
  assert.strictEqual(success.status, 'ready');
  assert.deepStrictEqual(calls.filter(args => args[1] === 'add'), [['plugin', 'add', 'codemap-boost-codex@codex-toolshop', '--json']]);
  assert.strictEqual(installed[1].enabled, false, 'disabled plugins are never reinstalled by the fallback');
  assert(calls.some(args => args[2] === 'upgrade' && args[3] === 'codex-toolshop'), 'native upgrade is scoped to the configured marketplace');
  const failed = api.checkPluginUpdates({ ...options, runCodex: args => args[2] === 'upgrade'
    ? { status: 1, stderr: 'cache is locked' } : runCodex(args) });
  assert.strictEqual(failed.status, 'failed');
  assert(failed.error.includes('cache is locked'));
  assert.strictEqual(failed.lastSuccessAt, success.lastSuccessAt, 'failure preserves the last successful check');
  const alien = api.checkPluginUpdates({ ...options, runCodex: () => ({ status: 0, stdout: JSON.stringify({ marketplaces: [{ ...source, marketplaceSource: { sourceType: 'local' } }] }) }) });
  assert.strictEqual(alien.status, 'failed', 'local and unrelated sources are not upgraded');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('plugin_updates.test.js PASS');
