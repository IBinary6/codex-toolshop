const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pluginRoot = path.join(__dirname, '..', '..', '..');

// 出厂模板必须含 enabled/mode/checks/copyrightInfo 全字段，且为合法 JSON
const tplPath = path.join(pluginRoot, 'templates', 'cpp-style-template.default.json');
assert.ok(fs.existsSync(tplPath), '出厂模板文件应存在');
const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf-8'));
assert.strictEqual(tpl.enabled, true, 'enabled 缺省 true');
assert.strictEqual(tpl.mode, 'incremental', 'mode 缺省 incremental');
assert.deepStrictEqual(tpl.checks, { clangFormat: true, copyright: true, cpplint: true, bom: true }, 'checks 四项全 true');
assert.strictEqual(tpl.copyrightInfo.company, '', 'company 缺省空串');
assert.strictEqual(tpl.copyrightInfo.author, '', 'author 缺省空串');
assert.strictEqual(tpl.copyrightInfo.dateFormat, 'YYYY/MM/DD HH:mm', 'dateFormat 缺省值');

// Codex 插件清单必须位于 .codex-plugin/plugin.json，并与当前插件版本一致
const pj = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf-8'));
assert.strictEqual(pj.name, 'cpp-style-enforcer-codex', 'Codex 插件名应正确');
assert.strictEqual(pj.version, '0.1.0', 'Codex 插件版本应与 package.json 同步');
assert.strictEqual(pj.hooks, './hooks/codex-hooks.json', 'Codex 插件应声明 hook manifest');
assert.strictEqual(pj.skills, './skills/', 'Codex 插件应声明 skills 目录');

// 目录骨架存在
for (const d of ['hooks/js/lib', 'hooks/js/steps', 'hooks/js/__tests__']) {
  assert.ok(fs.existsSync(path.join(pluginRoot, d)), `${d} 目录应存在`);
}
console.log('template.test.js PASS');
