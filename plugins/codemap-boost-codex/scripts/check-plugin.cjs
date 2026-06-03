'use strict';

const fs = require('fs');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');

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

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const repoRoot = findRepoRoot(pluginRoot);
  if (repoRoot) {
    const marketplace = readJson(path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'), 'marketplace');
    assert(marketplace.name === 'codex-toolshop', 'marketplace name must be codex-toolshop');
    const entry = marketplace.plugins.find((item) => item.name === 'codemap-boost-codex');
    assert(entry, 'marketplace must include codemap-boost-codex');
    assert(entry.source && entry.source.path === './plugins/codemap-boost-codex', 'marketplace source path is wrong');
  }

  const plugin = readJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'plugin.json');
  assert(plugin.name === 'codemap-boost-codex', 'plugin name is wrong');
  assert(plugin.hooks === './hooks/codex-hooks.json', 'plugin must declare hooks manifest');
  assert(plugin.skills === './skills/', 'plugin must declare skills directory');

  const hooks = readJson(path.join(pluginRoot, 'hooks', 'codex-hooks.json'), 'hooks manifest');
  for (const eventName of ['SessionStart', 'PostToolUse', 'PreToolUse', 'UserPromptSubmit', 'SubagentStart']) {
    assert(hooks.hooks[eventName], `${eventName} hook missing`);
  }
  const text = JSON.stringify(hooks);
  assert(text.includes('${PLUGIN_ROOT}'), 'hook commands must use ${PLUGIN_ROOT}');
  assert(!text.includes('async'), 'Codex skips async command hooks; manifest must not contain async');
  assert(!/[A-Za-z]:[\\/]/.test(text), 'hook commands must not contain absolute Windows paths');
  assert(!text.includes('/Users/') && !text.includes('/home/'), 'hook commands must not contain user absolute paths');

  console.log('check-plugin PASS');
}

main();
