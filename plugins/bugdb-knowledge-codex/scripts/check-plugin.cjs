'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const manifest = readJson('.codex-plugin/plugin.json');
  const packageJson = readJson('package.json');
  assert(manifest.name === 'bugdb-knowledge-codex', 'plugin name is wrong');
  assert(packageJson.name === manifest.name, 'package name must match plugin name');
  assert(packageJson.version === manifest.version, 'package version must match plugin version');
  assert(/^\d+\.\d+\.\d+$/.test(manifest.version), 'plugin version must be plain patch semver');
  assert(manifest.skills === './skills/', 'skills directory must be declared');
  assert(!Object.prototype.hasOwnProperty.call(manifest, 'hooks'), 'plugin.json must omit hooks');
  assert(fs.existsSync(path.join(root, manifest.interface.composerIcon)), 'composer icon is missing');
  assert(fs.existsSync(path.join(root, manifest.interface.logo)), 'plugin logo is missing');

  const hooks = readJson('hooks/hooks.json');
  const legacyHooks = readJson('hooks/codex-hooks.json');
  assert(JSON.stringify(hooks) === JSON.stringify(legacyHooks), 'hook manifests must match');
  assert(hooks && hooks.hooks, 'hooks manifest must contain hooks');
  for (const eventName of ['SessionStart', 'PostToolUse', 'UserPromptSubmit']) {
    assert(Array.isArray(hooks.hooks[eventName]), `${eventName} hook is missing`);
  }
  const hookText = JSON.stringify(hooks);
  assert(hookText.includes('${PLUGIN_ROOT}'), 'hooks must resolve plugin root at runtime');
  assert(!hookText.includes('"async"'), 'Codex command hooks must not be async');
  assert(!/[A-Za-z]:[\\/]/.test(hookText), 'hooks must not contain absolute Windows paths');
  assert(!hookText.includes('/Users/') && !hookText.includes('/home/'), 'hooks must not contain user paths');

  for (const skill of ['bugdb-lookup', 'bugdb-record', 'bugdb-migrate', 'bugdb-setup']) {
    const file = path.join(root, 'skills', skill, 'SKILL.md');
    assert(fs.existsSync(file), `missing ${skill} skill`);
    const text = fs.readFileSync(file, 'utf8');
    assert(new RegExp(`^---\\r?\\nname: ${skill}\\r?\\n`).test(text), `${skill} frontmatter is invalid`);
  }
  assert(!fs.existsSync(path.join(root, 'node_modules')), 'node_modules must not be committed');
  for (const relative of [
    'bugdb/cli.py', 'bugdb/db.py', 'bugdb/search.py', 'scripts/run-hook.cjs',
    'hooks/js/bugdb_check.js', 'hooks/js/user_prompt_submit.js',
  ]) {
    assert(fs.existsSync(path.join(root, relative)), `missing ${relative}`);
  }
  process.stdout.write('check-plugin PASS\n');
}

main();
