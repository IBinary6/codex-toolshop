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
 * 校验发布清单、hook、skill、共享策略与跨平台运行时不变量。
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
    'skills/conversation-title-manager/SKILL.md',
    'skills/conversation-title-manager/references/title-policy.md',
  ];
  for (const relative of required) {
    assert.ok(fs.existsSync(path.join(root, relative)), `missing ${relative}`);
  }

  const manifest = readJson('.codex-plugin/plugin.json');
  const packageJson = readJson('package.json');
  assert.equal(manifest.name, 'conversation-namer-codex');
  assert.equal(packageJson.name, manifest.name);
  assert.equal(packageJson.version, manifest.version);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.engines && packageJson.engines.node, '>=18');
  assert.equal(manifest.skills, './skills/');
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
  assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart'], 'only SessionStart may be registered');
  assert.equal(hooks.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  const hookText = JSON.stringify(hooks);
  assert.ok(hookText.includes('${PLUGIN_ROOT}'));
  assert.ok(!hookText.includes('Stop'), 'Stop hook must not be registered');
  assert.ok(!hookText.includes('UserPromptSubmit'), 'UserPromptSubmit must not be registered');
  assert.ok(!hookText.includes('"async"'), 'Codex command hooks must not be async');
  assert.doesNotMatch(hookText, /[A-Za-z]:[\\/]/, 'hooks must not contain absolute Windows paths');
  assert.ok(!hookText.includes('/Users/') && !hookText.includes('/home/'), 'hooks must not contain user paths');
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /\b(?:python|bash|sh)\b/i,
    'runtime checks and tests must use Node.js only');

  const skill = fs.readFileSync(path.join(root, 'skills', 'conversation-title-manager', 'SKILL.md'), 'utf8');
  const policy = fs.readFileSync(
    path.join(root, 'skills', 'conversation-title-manager', 'references', 'title-policy.md'),
    'utf8',
  );
  assert.match(skill, /^---\r?\nname: conversation-title-manager\r?\n/);
  assert.ok(!skill.includes('[TODO:'), 'skill contains a TODO placeholder');
  assert.match(skill, /\| Before \| After \|/);
  assert.match(skill, /explicit confirmation/i);
  assert.match(skill, /projectId/);
  assert.match(skill, /limit of at least `200`/);
  assert.match(skill, /Codex task\/thread entries/);
  assert.match(skill, /Exclude ChatGPT conversations/);
  assert.match(skill, /hostId/);
  assert.doesNotMatch(skill, /every automatic proposal/);
  assert.match(policy, /createdAt/);
  assert.match(policy, /Asia\/Shanghai/);
  for (const type of ['FEA', 'DES', 'FIX', 'OPT', 'REL', 'EXP', 'DOC', 'RES']) {
    assert.match(policy, new RegExp(`\\b${type}\\b`), `missing ${type} mapping`);
  }

  const guidance = fs.readFileSync(path.join(root, 'hooks', 'js', 'lib', 'guidance.js'), 'utf8');
  assert.match(guidance, /mandatory pre-task gate for every newly created Codex main task/);
  assert.match(guidance, /act immediately/);
  assert.match(guidance, /before starting the requested work/);
  assert.match(guidance, /before calling any unrelated tool/);
  assert.match(guidance, /short, simple, or already actionable/);
  assert.match(guidance, /Do not defer this until the final response/);
  assert.match(guidance, /current title already exactly equals the target title/);
  assert.doesNotMatch(guidance, /Before your final response/);
  const guidanceMarkers = [
    'Batch precedence:',
    'First call mcp__codex_app__read_thread',
    'Otherwise, immediately call mcp__codex_app__set_thread_title',
    'Only after this naming gate has completed or safely skipped may you start the requested work',
  ];
  const guidanceIndexes = guidanceMarkers.map((marker) => guidance.indexOf(marker));
  assert.ok(guidanceIndexes.every((index) => index >= 0), 'automatic naming gate markers are missing');
  assert.deepEqual(
    [...guidanceIndexes].sort((left, right) => left - right),
    guidanceIndexes,
    'automatic naming gate order is invalid',
  );

  const repoRoot = findRepoRoot(root);
  if (repoRoot) {
    const marketplace = JSON.parse(fs.readFileSync(
      path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'),
      'utf8',
    ));
    const entry = marketplace.plugins.find((item) => item.name === manifest.name);
    assert.ok(entry, 'marketplace must include conversation-namer-codex');
    assert.equal(entry.version, manifest.version, 'marketplace version must match plugin.json');
    assert.equal(entry.source && entry.source.path, './plugins/conversation-namer-codex');
  }

  assert.ok(!fs.existsSync(path.join(root, 'node_modules')), 'node_modules must not be committed');
  process.stdout.write('check-plugin PASS\n');
}

main();
