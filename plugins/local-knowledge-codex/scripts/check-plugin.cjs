'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function readJson(relative) {
  /** 读取并解析插件内 JSON 文件。 */
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function assert(condition, message) {
  /** 在插件结构不满足发布不变量时终止检查。 */
  if (!condition) throw new Error(message);
}

function main() {
  /** 校验 Local Knowledge 的清单、hook、skill 和运行时文件。 */
  const manifest = readJson('.codex-plugin/plugin.json');
  const packageJson = readJson('package.json');
  const pyproject = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
  const pyprojectVersion = pyproject.match(/^version\s*=\s*"([^"]+)"/m);
  assert(manifest.name === 'local-knowledge-codex', 'plugin name is wrong');
  assert(packageJson.name === manifest.name, 'package name must match plugin name');
  assert(packageJson.version === manifest.version, 'package version must match plugin version');
  assert(packageJson.engines && packageJson.engines.node === '>=18',
    'plugin must declare Node.js 18+');
  assert(pyprojectVersion && pyprojectVersion[1] === manifest.version,
    'pyproject version must match plugin version');
  assert(/^\d+\.\d+\.\d+$/.test(manifest.version), 'plugin version must be plain patch semver');
  assert(manifest.skills === './skills/', 'skills directory must be declared');
  assert(!Object.prototype.hasOwnProperty.call(manifest, 'hooks'), 'plugin.json must omit hooks');
  assert(fs.existsSync(path.join(root, manifest.interface.composerIcon)), 'composer icon is missing');
  assert(fs.existsSync(path.join(root, manifest.interface.logo)), 'plugin logo is missing');
  assert(!/bugdb/i.test(JSON.stringify(manifest)), 'user-facing manifest must use Local Knowledge semantics');

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

  for (const skill of [
    'local-knowledge-recall',
    'local-knowledge-save',
    'local-knowledge-migrate',
    'local-knowledge-setup',
  ]) {
    const file = path.join(root, 'skills', skill, 'SKILL.md');
    assert(fs.existsSync(file), `missing ${skill} skill`);
    const text = fs.readFileSync(file, 'utf8');
    assert(new RegExp(`^---\\r?\\nname: ${skill}\\r?\\n`).test(text), `${skill} frontmatter is invalid`);
  }
  assert(!fs.existsSync(path.join(root, 'node_modules')), 'node_modules must not be committed');
  for (const relative of [
    'bugdb/cli.py', 'bugdb/db.py', 'bugdb/search.py',
    'local_knowledge/cli.py', 'local_knowledge/storage.py',
    'scripts/run-hook.cjs', 'scripts/python-launcher.cjs',
    'hooks/js/local_knowledge_cli.js',
    'hooks/js/local_knowledge_check.js', 'hooks/js/local_knowledge_prompt.js',
    'hooks/js/local_knowledge_session.js',
  ]) {
    assert(fs.existsSync(path.join(root, relative)), `missing ${relative}`);
  }
  process.stdout.write('check-plugin PASS\n');
}

main();
