'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

const plugin = readJson('.codex-plugin/plugin.json');
const packageJson = readJson('package.json');
const hooks = readJson('hooks/hooks.json');
const legacy = readJson('hooks/codex-hooks.json');

assert.equal(plugin.name, packageJson.name);
assert.equal(plugin.version, packageJson.version);
assert.deepEqual(hooks, legacy);
for (const event of ['SessionStart', 'PostToolUse', 'UserPromptSubmit']) {
  assert.ok(Array.isArray(hooks.hooks[event]), `${event} must be registered`);
}
const text = JSON.stringify(hooks);
assert.match(text, /\$\{PLUGIN_ROOT\}/);
assert.doesNotMatch(text, /"async"/);
assert.doesNotMatch(text, /[A-Za-z]:[\\/]/);

const lookupSkill = fs.readFileSync(path.join(root, 'skills', 'bugdb-lookup', 'SKILL.md'), 'utf8');
const recordSkill = fs.readFileSync(path.join(root, 'skills', 'bugdb-record', 'SKILL.md'), 'utf8');
assert.match(lookupSkill, /replaced_by_id/);
assert.doesNotMatch(lookupSkill, /replacement_id/);
for (const kind of ['bug', 'practice', 'tool', 'decision', 'workflow']) {
  assert.match(recordSkill, new RegExp(`\\b${kind}\\b`));
}
console.log('manifest.test.js PASS');
