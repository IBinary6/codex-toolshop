'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const runtime = require('../scripts/tgrep.cjs');
const updates = require('../scripts/release-update.cjs');
function metadata(version = '1.0.6', key = updates.platformKey()) {
  const asset = updates.fallback.assets[key];
  return { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name: asset.archive.replace('v1.0.5', `v${version}`), browser_download_url: asset.url.replaceAll('v1.0.5', `v${version}`), digest: `sha256:${asset.sha256}` }] };
}
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgrep-update-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ...runtime, home: () => dir, ensureBinary: async candidate => path.join(dir, candidate.version, 'tgrep'), ...extra };
}
test('weekly TTL means seven complete days after any attempted check', () => {
  const now = 1800000000000;
  assert.equal(updates.WEEK_MS, 604800000);
  assert.equal(updates.due(null, now), true);
  assert.equal(updates.due({ lastChecked: now - updates.WEEK_MS + 1, outcome: 'error' }, now), false);
  assert.equal(updates.due({ lastChecked: now - updates.WEEK_MS }, now), true);
});
test('all six official platform assets require supplied SHA256 and exact release URL', () => {
  for (const key of Object.keys(updates.fallback.assets)) assert.equal(updates.fromLatest(metadata('1.2.3', key), key).version, '1.2.3');
  const missing = metadata(); delete missing.assets[0].digest;
  assert.throws(() => updates.fromLatest(missing), /SHA256/);
  const foreign = metadata(); foreign.assets[0].browser_download_url = 'https://example.com/tgrep.zip';
  assert.throws(() => updates.fromLatest(foreign), /URL/);
  const prerelease = metadata(); prerelease.prerelease = true;
  assert.throws(() => updates.fromLatest(prerelease), /stable/);
});
test('candidate becomes active only after install and isolated validation complete', async t => {
  const api = fixture(t);
  const events = [];
  api.ensureBinary = async candidate => { events.push(`installed:${candidate.version}`); return '/fixture/tgrep'; };
  const result = await updates.checkUpdates(api, { force: true, fetchRelease: async () => metadata(), validate: async () => {
    assert.equal(updates.activeRelease(api.home()).version, '1.0.5'); events.push('validated');
  } });
  assert.deepEqual(events, ['installed:1.0.6', 'validated']);
  assert.equal(result.outcome, 'updated');
  assert.equal(updates.activeRelease(api.home()).version, '1.0.6');
});
test('install or validation failure retains active release and records the attempted weekly check', async t => {
  for (const phase of ['install', 'validate']) {
    const api = fixture(t);
    if (phase === 'install') api.ensureBinary = async () => { throw new Error('download failed'); };
    const result = await updates.checkUpdates(api, { force: true, fetchRelease: async () => metadata(), validate: async () => { throw new Error('protocol failed'); } });
    assert.equal(result.outcome, 'error');
    assert.equal(updates.activeRelease(api.home()).version, '1.0.5');
    assert.match(result.error, phase === 'install' ? /download/ : /protocol/);
    assert.equal(updates.due(updates.status(api.home())), false);
  }
});
test('no downgrade, no digest and no incompatible source can install or activate', async t => {
  const api = fixture(t, { ensureBinary: async () => { assert.fail('must not install'); } });
  let result = await updates.checkUpdates(api, { force: true, fetchRelease: async () => metadata('1.0.4') });
  assert.equal(result.outcome, 'unchanged');
  const noDigest = metadata(); noDigest.assets[0].digest = null;
  result = await updates.checkUpdates(api, { force: true, fetchRelease: async () => noDigest });
  assert.equal(result.outcome, 'error');
  assert.equal(updates.activeRelease(api.home()).version, '1.0.5');
});
test('alive service binds its own version/index even after active release changes; legacy remains supported', () => {
  const ctx = { root: '/repo', dir: path.join(os.tmpdir(), 'worktree') };
  const next = updates.fromLatest(metadata('2.0.0'));
  const old = updates.serviceBinding(ctx, { version: '1.0.5', index: updates.indexForVersion(ctx.dir, '1.0.5') }, next);
  assert.equal(old.version, '1.0.5');
  assert.equal(old.index, updates.indexForVersion(ctx.dir, '1.0.5'));
  assert.equal(updates.serviceBinding(ctx, {}, next).index, path.join(ctx.dir, 'index'));
  assert.equal(updates.serviceBinding(ctx, {}, next).version, '1.0.5');
  assert.equal(updates.serviceBinding(ctx, null, next).index, updates.indexForVersion(ctx.dir, '2.0.0'));
  assert.throws(() => updates.serviceBinding(ctx, { version: '1.0.5', index: updates.indexForVersion(ctx.dir, '2.0.0') }, next), /mismatch/);
});
test('concurrent forced checks cannot publish twice', async t => {
  const api = fixture(t);
  let resolveFetch;
  const first = updates.checkUpdates(api, { force: true, fetchRelease: () => new Promise(resolve => { resolveFetch = resolve; }), validate: async () => {} });
  const second = await updates.checkUpdates(api, { force: true, fetchRelease: async () => { assert.fail('second fetch'); } });
  assert.equal(second.outcome, 'pending');
  resolveFetch(metadata());
  assert.equal((await first).outcome, 'updated');
});
test('recent failed check skips network while explicit force may retry', async t => {
  const api = fixture(t);
  const active = updates.fromLatest(metadata('1.0.6'));
  api.atomicJSON(path.join(api.home(), 'active-release.json'), active);
  const before = fs.readFileSync(path.join(api.home(), 'active-release.json'));
  await updates.checkUpdates(api, { force: true, fetchRelease: async () => { throw new Error('network unavailable'); } });
  assert.deepEqual(fs.readFileSync(path.join(api.home(), 'active-release.json')), before);
  const skipped = await updates.checkUpdates(api, { fetchRelease: async () => { assert.fail('seven-day TTL must prevent this fetch'); } });
  assert.equal(skipped.skipped, true);
  const forced = await updates.checkUpdates(api, { force: true, fetchRelease: async () => metadata('1.0.6') });
  assert.equal(forced.outcome, 'unchanged');
});
test('fetch fallback refuses an HTTPS-to-HTTP redirect', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return { status: 302, headers: { get: () => 'http://example.invalid/file' }, body: { cancel: async () => {} } };
  });
  await assert.rejects(updates.fetchHttps('https://github.com/microsoft/tgrep/releases/download/example'), /non-HTTPS/);
  assert.equal(requests, 1);
});
