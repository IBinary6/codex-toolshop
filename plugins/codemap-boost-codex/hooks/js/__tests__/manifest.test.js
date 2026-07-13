'use strict';

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const oldHost = 'CL' + 'AUDE';
const banned = [
  [oldHost, 'PLUGIN', 'ROOT'].join('_'),
  [oldHost, 'PLUGIN', 'DATA'].join('_'),
  [oldHost, 'WORKING', 'DIRECTORY'].join('_'),
  '~/' + 'cl' + 'aude',
  '.' + 'cl' + 'aude-plugin',
  oldHost + '.md',
];

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function findMarketplace(start) {
  let dir = path.resolve(start);
  let prev = null;
  while (dir && dir !== prev) {
    const candidate = path.join(dir, '.agents', 'plugins', 'marketplace.json');
    if (fs.existsSync(candidate)) return candidate;
    prev = dir;
    dir = path.dirname(dir);
  }
  return null;
}

const plugin = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
assert.strictEqual(plugin.name, 'codemap-boost-codex');
assert.strictEqual(Object.hasOwn(plugin, 'hooks'), false, 'plugin manifest omits unsupported hooks field');

const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
const legacyHooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'codex-hooks.json'), 'utf8'));
assert.deepStrictEqual(legacyHooks, hooks, 'hooks/codex-hooks.json must stay in sync with hooks/hooks.json');
assert.deepStrictEqual(Object.keys(hooks), ['hooks'], 'Codex hooks manifest must only contain a top-level hooks key');
assert.ok(hooks.hooks.UserPromptSubmit[0].matcher === undefined, 'UserPromptSubmit must not use matcher');
assert.ok(JSON.stringify(hooks).includes('${PLUGIN_ROOT}'), 'hook commands use PLUGIN_ROOT placeholder');
assert.ok(!JSON.stringify(hooks).includes('"async"'), 'manifest must not use async hooks');
assert.ok(
  hooks.hooks.PreToolUse.some((group) => /mcp__.*(?:code_review_graph|code-review-graph|codegraph|graphify)/.test(group.matcher || '')),
  'PreToolUse must refresh before graph MCP access'
);
assert.ok(
  JSON.stringify(hooks.hooks.PreToolUse).includes('pre_graph_tool'),
  'graph MCP barrier must use the pre_graph_tool hook'
);
assert.ok(
  hooks.hooks.PostToolUse.some((group) => String(group.matcher || '').includes('apply_patch')),
  'PostToolUse must refresh after apply_patch edits'
);
assert.ok(
  hooks.hooks.SessionStart[0].hooks[0].timeout >= 300,
  'SessionStart refresh needs enough time for a full build'
);

const marketplacePath = findMarketplace(pluginRoot);
if (marketplacePath) {
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  assert.ok(marketplace.plugins.some((item) => item.name === 'codemap-boost-codex'), 'marketplace entry exists');
}

for (const file of listFiles(pluginRoot)) {
  const rel = path.relative(pluginRoot, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  for (const token of banned) {
    assert.ok(!text.includes(token), `${rel} must not contain old host token ${token}`);
  }
}

console.log('manifest.test.js PASS');
