'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

/**
 * 读取插件内 JSON 文件。
 *
 * @param {string} relative 相对插件根目录的路径。
 * @returns {object} 已解析 JSON。
 * @example
 * const manifest = readJson('.codex-plugin/plugin.json');
 */
function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

/**
 * 从插件目录向上定位可选的工具仓库根目录。
 *
 * @param {string} start 起始目录。
 * @returns {string|null} 仓库根目录，或空值。
 * @example
 * const repoRoot = findRepoRoot(root);
 */
function findRepoRoot(start) {
  let directory = path.resolve(start);
  let previous = null;
  while (directory && directory !== previous) {
    if (fs.existsSync(path.join(directory, '.agents', 'plugins', 'marketplace.json'))) return directory;
    previous = directory;
    directory = path.dirname(directory);
  }
  return null;
}

/**
 * 校验发布清单、hook 与跨平台运行时不变量。
 *
 * @returns {void}
 * @example
 * main();
 */
function main() {
  const required = [
    '.codex-plugin/plugin.json',
    'assets/icon.svg',
    'assets/logo.svg',
    'hooks/hooks.json',
    'hooks/codex-hooks.json',
    'scripts/run-hook.cjs',
    'hooks/js/user_prompt_submit.js',
    'hooks/js/name_worker.js',
    'hooks/js/startup_observer.js',
    'hooks/js/lib/first_prompt.js',
    'hooks/js/lib/state.js',
    'hooks/js/lib/naming.js',
    'hooks/js/lib/app_server.js',
  ];
  for (const relative of required) {
    assert.ok(fs.existsSync(path.join(root, relative)), `missing ${relative}`);
  }

  const manifest = readJson('.codex-plugin/plugin.json');
  const packageJson = readJson('package.json');
  assert.equal(manifest.name, 'conversation-namer-codex');
  assert.equal(packageJson.name, manifest.name);
  const releaseVersion = manifest.version.split('+')[0];
  assert.equal(packageJson.version, releaseVersion);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\+codex\.[a-z0-9-]+)?$/);
  assert.equal(packageJson.engines && packageJson.engines.node, '>=18');
  assert.ok(!Object.hasOwn(manifest, 'skills'), 'automatic naming must not expose a manual skill');
  assert.ok(!Object.hasOwn(manifest, 'hooks'), 'default hook discovery must be used');
  assert.ok(Array.isArray(manifest.interface.defaultPrompt));
  assert.deepEqual(manifest.interface.capabilities, ['Read', 'Write']);
  for (const field of ['composerIcon', 'logo']) {
    const iconPath = path.join(root, manifest.interface[field]);
    assert.ok(fs.existsSync(iconPath), `${field} is missing`);
    assert.match(fs.readFileSync(iconPath, 'utf8'), /^<svg\b/);
  }

  const hooks = readJson('hooks/hooks.json');
  const legacyHooks = readJson('hooks/codex-hooks.json');
  assert.deepEqual(hooks, legacyHooks, 'hook manifests must stay identical');
  assert.ok(Array.isArray(hooks.hooks.SessionStart));
  assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart', 'UserPromptSubmit']);
  assert.equal(hooks.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  const hookText = JSON.stringify(hooks);
  assert.ok(hookText.includes('${PLUGIN_ROOT}'));
  assert.ok(!hookText.includes('Stop'), 'Stop hook must not be registered');
  assert.ok(Array.isArray(hooks.hooks.UserPromptSubmit));
  assert.ok(!hookText.includes('"async"'), 'Codex command hooks must not be async');
  assert.doesNotMatch(hookText, /[A-Za-z]:[\\/]/, 'hooks must not contain absolute Windows paths');
  assert.ok(!hookText.includes('/Users/') && !hookText.includes('/home/'), 'hooks must not contain user paths');
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /\b(?:python|bash|sh)\b/i,
    'runtime checks and tests must use Node.js only');

  const guidance = fs.readFileSync(path.join(root, 'hooks', 'js', 'lib', 'guidance.js'), 'utf8');
  assert.doesNotMatch(guidance, /mandatory pre-task gate|already contains an assistant turn|set_thread_title/,
    'automatic naming must not be delegated to the main task prompt');

  const repoRoot = findRepoRoot(root);
  if (repoRoot) {
    const marketplace = JSON.parse(fs.readFileSync(
      path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'),
      'utf8',
    ));
    const entry = marketplace.plugins.find((item) => item.name === manifest.name);
    assert.ok(entry, 'marketplace must include conversation-namer-codex');
    assert.equal(entry.version, releaseVersion, 'marketplace must match the plugin release version');
    assert.equal(entry.source && entry.source.path, './plugins/conversation-namer-codex');
  }

  assert.ok(!fs.existsSync(path.join(root, 'node_modules')), 'node_modules must not be committed');
  process.stdout.write('check-plugin PASS\n');
}

main();
