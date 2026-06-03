'use strict';

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const oldHost = 'CL' + 'AUDE';

const banned = [
  [oldHost, 'PLUGIN', 'ROOT'].join('_'),
  [oldHost, 'PLUGIN', 'DATA'].join('_'),
  [oldHost, 'PROJECT', 'DIR'].join('_'),
  [oldHost, 'WORKING', 'DIRECTORY'].join('_'),
  '~/' + 'cl' + 'aude',
  '.' + 'cl' + 'aude-plugin',
];

const allowedDirs = new Set([
  '.git',
  'node_modules',
]);

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (allowedDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

for (const file of listFiles(pluginRoot)) {
  const rel = path.relative(pluginRoot, file).replace(/\\/g, '/');
  if (rel.startsWith('hooks/js/cpplint/')) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const token of banned) {
    assert.ok(
      !text.includes(token),
      `${rel} must not reference old host runtime token ${token}`,
    );
  }
}

const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'codex-hooks.json'), 'utf8'));
const hooksText = JSON.stringify(hooks);
assert.ok(hooksText.includes('${PLUGIN_ROOT}'), 'hook commands must use ${PLUGIN_ROOT}');
assert.ok(!hooksText.includes('${' + [oldHost, 'PLUGIN', 'ROOT'].join('_') + '}'), 'hook commands must not use old host placeholders');

console.log('codex_runtime_contract.test.js PASS');
