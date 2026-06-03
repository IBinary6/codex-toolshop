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

// plugin.json 版本必须为 0.3.2
const pj = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8'));
assert.strictEqual(pj.version, '0.3.2', '版本应升到 0.3.2');

// 目录骨架存在
for (const d of ['hooks/js/lib', 'hooks/js/steps', 'hooks/js/__tests__']) {
  assert.ok(fs.existsSync(path.join(pluginRoot, d)), `${d} 目录应存在`);
}
console.log('template.test.js PASS');
