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

const repoRoot = findRepoRoot(pluginRoot);

function readJson(full, label) {
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoAbsoluteCommandPaths(hooks) {
  const text = JSON.stringify(hooks);
  assert(!/[A-Za-z]:[\\/]/.test(text), 'hook config must not contain Windows absolute paths');
  assert(!text.includes('/Users/') && !text.includes('/home/'), 'hook config must not contain user absolute paths');
}

function main() {
  if (repoRoot) {
    const marketplace = readJson(
      path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'),
      '.agents/plugins/marketplace.json'
    );
    assert(marketplace.name === 'codex-toolshop', 'marketplace name must be codex-toolshop');
    assert(Array.isArray(marketplace.plugins), 'marketplace plugins must be an array');
    const entry = marketplace.plugins.find((p) => p.name === 'cpp-style-enforcer-codex');
    assert(entry, 'marketplace must include cpp-style-enforcer-codex');
    assert(entry.source && entry.source.path === './plugins/cpp-style-enforcer-codex', 'marketplace source path is wrong');
  }

  const plugin = readJson(
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    '.codex-plugin/plugin.json'
  );
  assert(plugin.name === 'cpp-style-enforcer-codex', 'plugin name is wrong');
  assert(plugin.hooks === './hooks/hooks.json', 'plugin must declare default Codex hooks manifest');
  assert(plugin.skills === './skills/', 'plugin must declare skills directory');
  assert(Array.isArray(plugin.interface.defaultPrompt), 'defaultPrompt must be an array');

  const hooks = readJson(
    path.join(pluginRoot, 'hooks', 'hooks.json'),
    'hooks/hooks.json'
  );
  const legacyHooks = readJson(
    path.join(pluginRoot, 'hooks', 'codex-hooks.json'),
    'hooks/codex-hooks.json'
  );
  assert(JSON.stringify(legacyHooks) === JSON.stringify(hooks), 'legacy codex-hooks.json must match hooks/hooks.json');
  assert(hooks.hooks.SessionStart, 'SessionStart hook missing');
  assert(hooks.hooks.PostToolUse, 'PostToolUse hook missing');
  assert(hooks.hooks.PreToolUse, 'PreToolUse hook missing');
  assertNoAbsoluteCommandPaths(hooks);

  const nodeModules = path.join(pluginRoot, 'node_modules');
  assert(!fs.existsSync(nodeModules), 'node_modules must not be committed in the plugin');

  console.log('check-plugin PASS');
}

main();
