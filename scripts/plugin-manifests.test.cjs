#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, 'plugin-manifests.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-manifests-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const runBump = (plugin, how) => spawnSync(process.execPath, [script, 'bump', plugin, how, root], { encoding: 'utf8' });
const check = () => spawnSync(process.execPath, [script, '--check', root], { encoding: 'utf8' });

function plugin(name, version, category = 'Coding') {
  write(`plugins/${name}/.codex-plugin/plugin.json`, json({ name, version, interface: { category } }));
  write(`plugins/${name}/package.json`, json({ name, version }));
}

try {
  // A plain plugin, one whose package lock lists dependency versions after its own two, and one with a pyproject.
  // The marketplace entry for the first keeps `version` after `category`, the order that broke a pattern-based edit.
  plugin('plain-codex', '0.1.3');
  plugin('cpp-style-enforcer-codex', '0.1.15');
  plugin('local-knowledge-codex', '0.2.6', 'Productivity');
  write('plugins/cpp-style-enforcer-codex/package-lock.json', '{\n  "version": "0.1.15",\n  "packages": {\n    "": {\n      "version": "0.1.15"\n    },\n    "node_modules/dep": {\n      "version": "2.1.2"\n    }\n  }\n}\n');
  write('plugins/local-knowledge-codex/pyproject.toml', '[project]\nname = "local-knowledge-codex"\nversion = "0.2.6"\n');
  write('.agents/plugins/marketplace.json', json({ plugins: [
    { name: 'plain-codex', category: 'Coding', version: '0.1.3' },
    { name: 'cpp-style-enforcer-codex', version: '0.1.15', category: 'Coding' },
    { name: 'local-knowledge-codex', version: '0.2.6', category: 'Productivity' },
  ] }));
  assert.equal(check().status, 0, check().stderr);

  const bumped = runBump('cpp-style-enforcer-codex', 'patch');
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.equal(check().status, 0, 'every copy moved together');
  assert.equal(JSON.parse(read('plugins/cpp-style-enforcer-codex/.codex-plugin/plugin.json')).version, '0.1.16');
  assert.match(read('plugins/cpp-style-enforcer-codex/package-lock.json'), /"version": "0.1.16"[\s\S]*"version": "0.1.16"[\s\S]*"version": "2.1.2"/, 'both own versions change, the dependency does not');
  assert.equal(JSON.parse(read('.agents/plugins/marketplace.json')).plugins[1].version, '0.1.16');

  assert.equal(runBump('plain-codex', 'minor').status, 0);
  assert.equal(JSON.parse(read('plugins/plain-codex/package.json')).version, '0.2.0');
  assert.equal(runBump('local-knowledge-codex', '1.0.0').status, 0);
  assert.match(read('plugins/local-knowledge-codex/pyproject.toml'), /version = "1\.0\.0"/);
  assert.notEqual(runBump('plain-codex', 'sideways').status, 0, 'not a version');
  assert.notEqual(runBump('missing-codex', 'patch').status, 0, 'unknown plugin');
  assert.equal(check().status, 0);

  // Each kind of drift is reported by plugin and file.
  const drift = (file, edit, expected) => {
    const before = read(file);
    write(file, edit(before));
    const result = check();
    assert.equal(result.status, 1, `${file} drift is detected`);
    assert.match(result.stderr, expected);
    write(file, before);
    assert.equal(check().status, 0);
  };
  drift('plugins/plain-codex/package.json', (text) => text.replace('0.2.0', '0.1.9'), /plain-codex: plugins\/plain-codex\/package\.json says 0\.1\.9, plugin\.json says 0\.2\.0/);
  drift('plugins/local-knowledge-codex/pyproject.toml', (text) => text.replace('1.0.0', '0.9.0'), /local-knowledge-codex: .*pyproject\.toml says 0\.9\.0/);
  drift('plugins/cpp-style-enforcer-codex/package-lock.json', (text) => text.replace('"version": "0.1.16"', '"version": "0.1.14"'), /package-lock\.json says 0\.1\.14/);
  const edited = (change) => (text) => { const catalog = JSON.parse(text); change(catalog.plugins[0]); return json(catalog); };
  drift('.agents/plugins/marketplace.json', edited((entry) => { entry.version = '0.1.0'; }), /plain-codex: .*marketplace\.json says 0\.1\.0, plugin\.json says 0\.2\.0/);
  drift('.agents/plugins/marketplace.json', edited((entry) => { delete entry.version; }), /plain-codex: .*says \(no version\)/);
  drift('.agents/plugins/marketplace.json', edited((entry) => { entry.category = 'Productivity'; }), /plain-codex: .* category is Productivity, plugin\.json says Coding/);
  // A command hook that sets async never runs under Codex; that is reported for any plugin and either hook file.
  const hooks = (file, flag) => write(file, json({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node x.js', ...flag }] }] } }));
  hooks('plugins/plain-codex/hooks/hooks.json', {});
  hooks('plugins/plain-codex/hooks/codex-hooks.json', {});
  assert.equal(check().status, 0, 'hooks without async pass');
  hooks('plugins/plain-codex/hooks/hooks.json', { async: true });
  assert.match(check().stderr, /plain-codex: hooks\/hooks\.json sets async on a SessionStart hook/);
  hooks('plugins/plain-codex/hooks/hooks.json', {});
  hooks('plugins/plain-codex/hooks/codex-hooks.json', { async: false });
  assert.match(check().stderr, /hooks\/codex-hooks\.json sets async/, 'even async: false is a hook Codex does not handle as usual');
  console.log('plugin-manifests.test.cjs PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
