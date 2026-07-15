'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function findRepoRoot(start) {
  let dir = path.resolve(start);
  let prev = null;
  while (dir && dir !== prev) {
    if (fs.existsSync(path.join(dir, '.agents', 'plugins', 'marketplace.json'))) return dir;
    prev = dir;
    dir = path.dirname(dir);
  }
  return null;
}

const required = [
  '.codex-plugin/plugin.json',
  'defaults/dispatch-rules.json',
  'hooks/hooks.json',
  'scripts/run-hook.cjs',
  'skills/agent-dispatch-setup/SKILL.md',
];
for (const file of required) {
  assert.ok(fs.existsSync(path.join(root, file)), `missing ${file}`);
}

const manifest = readJson('.codex-plugin/plugin.json');
const packageJson = readJson('package.json');
assert.equal(manifest.name, packageJson.name);
assert.equal(manifest.version, packageJson.version);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.ok(Array.isArray(manifest.interface.defaultPrompt));
assert.ok(!Object.hasOwn(manifest, 'hooks'), 'default hooks discovery should be used');

const repoRoot = findRepoRoot(root);
if (repoRoot) {
  const marketplace = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(marketplace.name, 'codex-toolshop');
  const entry = marketplace.plugins.find((item) => item.name === 'agent-dispatch-codex');
  assert.ok(entry, 'marketplace must include agent-dispatch-codex');
  assert.equal(entry.version, manifest.version, 'marketplace version must match plugin.json');
  assert.equal(entry.source && entry.source.path, './plugins/agent-dispatch-codex');
}

const hooks = readJson('hooks/hooks.json').hooks;
for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SubagentStart']) {
  assert.ok(Array.isArray(hooks[event]), `missing ${event}`);
}
for (const groups of Object.values(hooks)) {
  for (const group of groups) {
    for (const hook of group.hooks || []) {
      assert.equal(hook.type, 'command');
      assert.equal(hook.async, undefined, 'Codex skips async command hooks');
      const match = hook.command.match(/run-hook\.cjs\\?"?\s+([a-z_]+)/);
      assert.ok(match, `unexpected hook command: ${hook.command}`);
    }
  }
}

const skill = fs.readFileSync(path.join(root, 'skills', 'agent-dispatch-setup', 'SKILL.md'), 'utf8');
assert.match(skill, /^---\r?\nname: agent-dispatch-setup\r?\n/);
assert.ok(!skill.includes('[TODO:'), 'skill contains a TODO placeholder');

process.stdout.write('check-plugin PASS\n');
