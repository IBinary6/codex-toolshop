'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

const plugin = readJson('.codex-plugin/plugin.json');
const packageJson = readJson('package.json');
const pyproject = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
const marketplace = JSON.parse(fs.readFileSync(
  path.resolve(root, '..', '..', '.agents', 'plugins', 'marketplace.json'), 'utf8'));
const hooks = readJson('hooks/hooks.json');
const legacy = readJson('hooks/codex-hooks.json');

assert.equal(plugin.name, packageJson.name);
assert.equal(plugin.name, 'local-knowledge-codex');
assert.equal(path.basename(root), plugin.name);
assert.equal(plugin.version, '0.2.0');
assert.equal(plugin.version, packageJson.version);
assert.equal(plugin.interface.displayName, 'Local Knowledge for Codex');
assert.doesNotMatch(JSON.stringify(plugin), /bugdb/i);
assert.deepEqual(hooks, legacy);
for (const event of ['SessionStart', 'PostToolUse', 'UserPromptSubmit']) {
  assert.ok(Array.isArray(hooks.hooks[event]), `${event} must be registered`);
}
const text = JSON.stringify(hooks);
assert.match(text, /\$\{PLUGIN_ROOT\}/);
assert.doesNotMatch(text, /"async"/);
assert.doesNotMatch(text, /[A-Za-z]:[\\/]/);

for (const skill of [
  'local-knowledge-recall',
  'local-knowledge-save',
  'local-knowledge-migrate',
  'local-knowledge-setup',
]) {
  const skillFile = path.join(root, 'skills', skill, 'SKILL.md');
  assert.ok(fs.existsSync(skillFile), `${skill} must exist`);
  const skillText = fs.readFileSync(skillFile, 'utf8');
  assert.match(skillText, new RegExp(`^---\\r?\\nname: ${skill}\\r?\\n`));
  assert.doesNotMatch(skillText, /bugdb-(?:lookup|record|migrate|setup)/i);
}
assert.match(pyproject, /knowledge-codex\s*=\s*"local_knowledge\.cli:main"/);
assert.match(pyproject, /bugdb-codex\s*=\s*"bugdb\.cli:main"/);
assert.ok(fs.existsSync(path.join(root, 'local_knowledge', 'cli.py')));
const marketplaceEntry = marketplace.plugins.find((entry) => entry.name === plugin.name);
assert.ok(marketplaceEntry, 'marketplace must publish the renamed plugin');
assert.equal(marketplaceEntry.version, plugin.version);
assert.equal(marketplaceEntry.source.path, './plugins/local-knowledge-codex');
assert.equal(marketplace.plugins.some((entry) => entry.name === 'bugdb-knowledge-codex'), false);
console.log('manifest.test.js PASS');
