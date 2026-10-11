const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pluginRoot = path.join(__dirname, '..', '..', '..');

// Factory template must have enabled/mode/checks/copyrightInfo and valid JSON.
const tplPath = path.join(pluginRoot, 'templates', 'cpp-style-template.default.json');
assert.ok(fs.existsSync(tplPath), 'Factory template exists');
const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf-8'));
assert.strictEqual(tpl.enabled, true, 'enabled defaults to true');
assert.strictEqual(tpl.mode, 'incremental', 'Default mode is incremental');
assert.deepStrictEqual(tpl.checks, { clangFormat: true, copyright: true, cpplint: true, bom: true }, 'All four checks are enabled');
assert.deepStrictEqual(
  tpl.legacyChecks,
  { clangFormat: false, copyright: false, cpplint: false, bom: false },
  'Tracked files preserve their original encoding and format by default',
);
assert.strictEqual(tpl.copyrightInfo.company, '', 'Default company is empty');
assert.strictEqual(tpl.copyrightInfo.author, '', 'Default author is empty');
assert.strictEqual(tpl.copyrightInfo.dateFormat, 'YYYY/MM/DD HH:mm', 'Default dateFormat is correct');

// Codex plugin manifest must be at .codex-plugin/plugin.json and match the current version.
const pj = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf-8'));
const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf-8'));
assert.strictEqual(pj.name, 'cpp-style-enforcer-codex', 'Codex plugin name is correct');
assert.strictEqual(pj.version.split('+')[0], pkg.version, 'Codex plugin version matches package.json, allowing a local cache suffix');
assert.strictEqual(Object.hasOwn(pj, 'hooks'), false, 'Codex plugin manifest omits the unsupported hooks field');
assert.strictEqual(pj.skills, './skills/', 'Codex plugin declares the skills directory');

// Directory skeleton exists.
for (const d of ['hooks/js/lib', 'hooks/js/steps', 'hooks/js/__tests__']) {
  assert.ok(fs.existsSync(path.join(pluginRoot, d)), `${d} directory exists`);
}
console.log('template.test.js PASS');
