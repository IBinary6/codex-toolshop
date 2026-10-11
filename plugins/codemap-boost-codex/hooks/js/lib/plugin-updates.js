'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { codexHome } = require('./runtime');
const { acquireInstallLock, releaseInstallLock } = require('./bootstrap');
const { runCodexMcp } = require('./codemap');

const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MARKETPLACE = 'codex-toolshop';
const SOURCE = 'https://github.com/IBinary6/codex-toolshop';

function paths(options = {}) {
  const home = path.resolve(options.codexHome || codexHome());
  const dir = path.join(home, 'plugins', 'data', 'codex-toolshop-updates');
  return { home, dir, state: path.join(dir, 'state.json'), lock: path.join(dir, 'update.lock') };
}
function readState(options = {}) {
  try { return JSON.parse(fs.readFileSync(paths(options).state, 'utf8')); } catch (_) { return {}; }
}
function writeState(state, options = {}) {
  const file = paths(options).state;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), 'utf8');
  fs.renameSync(temp, file);
}
function isInstalledCopy(options = {}) {
  const root = path.resolve(options.pluginRoot || path.join(__dirname, '..', '..', '..'));
  const cache = path.join(paths(options).home, 'plugins', 'cache', MARKETPLACE, 'codemap-boost-codex');
  const relative = path.relative(cache, root);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.split(path.sep).length === 1;
}
function disabled(options = {}) {
  return (options.env || process.env).CODEX_TOOLSHOP_DISABLE_PLUGIN_UPDATES === '1';
}
function due(state, now) {
  return !Number.isFinite(state.lastAttemptAt) || now - state.lastAttemptAt >= INTERVAL_MS || state.lastAttemptAt > now;
}

/** Schedule native refresh only for installed official plugins; source development and ordinary tests do not upgrade user plugins. */
function schedulePluginUpdate(options = {}) {
  if (disabled(options) || !isInstalledCopy(options)) return false;
  const now = options.now ?? Date.now();
  if (!due(readState(options), now)) return false;
  const lockFile = paths(options).lock;
  const token = acquireInstallLock(lockFile, { installLockWaitMs: 100 });
  if (!token) return false;
  try {
    if (!due(readState(options), now)) return false;
    writeState({ ...readState(options), lastAttemptAt: now, status: 'scheduled' }, options);
    const launch = options.spawn || spawn;
    const child = launch(process.execPath, [path.resolve(__dirname, '../../../scripts/plugin-update.cjs'), '--scheduled'], {
      env: { ...process.env, ...(options.env || {}), CODEX_HOME: paths(options).home },
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on('error', (error) => writeState({ ...readState(options), status: 'failed', error: error.message }, options));
    child.unref();
    return true;
  } catch (error) {
    writeState({ ...readState(options), status: 'failed', error: error.message }, options);
    return false;
  } finally { releaseInstallLock(lockFile, token); }
}

function runJson(args, options) {
  const run = options.runCodex || runCodexMcp;
  const result = run(args, { env: { ...process.env, ...(options.env || {}), CODEX_HOME: paths(options).home }, timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `Codex ${args.slice(0, 3).join(' ')} failed (${result.status}): ${String(result.stderr || '').slice(-600)}`);
  return JSON.parse(result.stdout);
}

function publishedVersion(market, name) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Plugin name does not meet this marketplace convention');
  const root = fs.realpathSync(market.root);
  const file = fs.realpathSync(path.join(root, 'plugins', name, '.codex-plugin', 'plugin.json'));
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Plugin source path is outside the marketplace');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.name !== name || typeof manifest.version !== 'string') throw new Error(`Invalid plugin source manifest: ${name}`);
  return manifest.version;
}

/** The host maintains the plugin cache. Update only installed and enabled plugins; do not create registrations or forcibly unlock the cache. */
function checkPluginUpdates(options = {}) {
  if (disabled(options)) return { ...readState(options), status: 'disabled' };
  const token = acquireInstallLock(paths(options).lock, { installLockWaitMs: 2000 });
  if (!token) return { ...readState(options), status: 'busy' };
  let state = { ...readState(options), lastAttemptAt: options.now ?? Date.now(), status: 'checking' };
  try {
    writeState(state, options);
    const marketplaces = runJson(['plugin', 'marketplace', 'list', '--json'], options).marketplaces || [];
    const market = marketplaces.find(item => item.name === MARKETPLACE);
    if (!market || market.marketplaceSource?.sourceType !== 'git'
      || String(market.marketplaceSource.source).replace(/\.git\/?$/, '').replace(/\/$/, '') !== SOURCE) {
      throw new Error('The official codex-toolshop Git marketplace is not configured; local and other sources were left unchanged.');
    }
    const before = runJson(['plugin', 'list', '--marketplace', MARKETPLACE, '--json'], options).installed || [];
    // Native upgrade may refresh the cache. Do not delete or retry occupied paths when a plugin encounters a file lock.
    runJson(['plugin', 'marketplace', 'upgrade', MARKETPLACE, '--json'], options);
    const listing = runJson(['plugin', 'list', '--marketplace', MARKETPLACE, '--json'], options);
    const installed = listing.installed || [];
    for (const prior of before.filter(item => item.installed && item.enabled)) {
      const current = installed.find(item => item.name === prior.name);
      const version = publishedVersion(market, prior.name);
      if (current?.version !== version) {
        runJson(['plugin', 'add', `${prior.name}@${MARKETPLACE}`, '--json'], options);
      }
    }
    const after = runJson(['plugin', 'list', '--marketplace', MARKETPLACE, '--json'], options);
    for (const prior of before) {
      const current = (after.installed || []).find(item => item.name === prior.name);
      if (!current || current.enabled !== prior.enabled) throw new Error(`Plugin state changed after native update: ${prior.name}; check host state.`);
      if (prior.enabled && current.version !== publishedVersion(market, prior.name)) throw new Error(`Plugin cache still needs an update: ${prior.name}`);
    }
    state = { ...state, status: 'ready', lastSuccessAt: Date.now(), error: null,
      installed: (after.installed || []).map(item => ({ name: item.name, version: item.version, enabled: item.enabled })) };
  } catch (error) { state = { ...state, status: 'failed', error: error.message }; }
  finally { writeState(state, options); releaseInstallLock(paths(options).lock, token); }
  return state;
}

module.exports = { INTERVAL_MS, due, isInstalledCopy, readState, schedulePluginUpdate, checkPluginUpdates };
