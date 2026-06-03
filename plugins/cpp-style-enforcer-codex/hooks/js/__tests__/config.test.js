const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, ensureUserTemplate, DEFAULT_CONFIG } = require('../lib/config.js');

// 隔离：本测试所有 ensureUserTemplate/loadConfig 调用都显式传入临时路径参数，
// 绝不依赖 os.homedir() 默认值，因此绝不读写真实 ~/.codex/cpp-style-template.json。
// 额外用 cleanup 收集所有临时目录，finally 统一删除。
const cleanupDirs = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

try {
  // ---- ensureUserTemplate：已存在绝不覆盖（写前后字节一致，含用户自填字段）----
  const tmpl = mkTmp('tmpl-');
  const defaultPath = path.join(tmpl, 'cpp-style-template.default.json');
  fs.writeFileSync(defaultPath, JSON.stringify(DEFAULT_CONFIG));
  const userPath = path.join(tmpl, 'user-template.json');
  const userContent = JSON.stringify({ enabled: true, mode: 'full', checks: {}, copyrightInfo: { company: 'ACME', author: 'kevin', dateFormat: 'YYYY/MM/DD HH:mm' } });
  fs.writeFileSync(userPath, userContent);
  const before = fs.readFileSync(userPath);
  ensureUserTemplate(defaultPath, userPath);
  const after = fs.readFileSync(userPath);
  assert.ok(before.equals(after), '已存在模板写前后字节完全一致');

  // ---- ensureUserTemplate：不存在则复制 ----
  const userPath2 = path.join(tmpl, 'fresh-template.json');
  ensureUserTemplate(defaultPath, userPath2);
  assert.ok(fs.existsSync(userPath2), '不存在则从默认复制');
  assert.ok(fs.readFileSync(userPath2).equals(fs.readFileSync(defaultPath)), '复制内容与默认一致');

  // ---- ensureUserTemplate：复制失败不崩（默认源不存在）----
  assert.doesNotThrow(() => ensureUserTemplate(path.join(tmpl, 'no-such.json'), path.join(tmpl, 'x.json')), '复制失败 try/catch 不崩');

  // ---- loadConfig：字段级覆盖（全局模板 ⊕ 项目）----
  const proj = mkTmp('proj-');
  const cfgDir = path.join(proj, '.claude-cpp-style');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({ mode: 'full', checks: { cpplint: false }, copyrightInfo: { company: 'OVERRIDE' } }));
  const srcFile = path.join(proj, 'a.cpp');
  fs.writeFileSync(srcFile, 'int a;');
  const cfg = loadConfig(srcFile, userPath);
  assert.strictEqual(cfg.mode, 'full', '项目覆盖 mode=full');
  assert.strictEqual(cfg.checks.cpplint, false, '项目覆盖 cpplint=false');
  assert.strictEqual(cfg.checks.bom, true, '未覆盖的 checks 缺失默认 true');
  assert.strictEqual(cfg.checks.clangFormat, true, '未覆盖的 clangFormat 默认 true');
  assert.strictEqual(cfg.copyrightInfo.company, 'OVERRIDE', '项目覆盖 company');
  assert.strictEqual(cfg.copyrightInfo.author, 'kevin', '未覆盖 author 回退全局');
  assert.strictEqual(cfg.enabled, true, 'enabled 缺省 true');

  // ---- loadConfig：损坏 JSON 回退默认 ----
  const proj2 = mkTmp('proj2-');
  const cfgDir2 = path.join(proj2, '.claude-cpp-style');
  fs.mkdirSync(cfgDir2, { recursive: true });
  fs.writeFileSync(path.join(cfgDir2, 'cpp-style.json'), '{ broken json ');
  const src2 = path.join(proj2, 'b.cpp');
  fs.writeFileSync(src2, 'int b;');
  const cfg2 = loadConfig(src2, path.join(tmpl, 'no-global.json'));
  assert.strictEqual(cfg2.enabled, true, '损坏 JSON + 无全局 → 硬编码默认 enabled true');
  assert.strictEqual(cfg2.mode, 'incremental', '损坏 JSON → 默认 incremental');
  assert.deepStrictEqual(cfg2.checks, { clangFormat: true, copyright: true, cpplint: true, bom: true }, '损坏 JSON → checks 全默认 true');

  // ---- loadConfig：enabled:false 生效 ----
  const proj3 = mkTmp('proj3-');
  const cfgDir3 = path.join(proj3, '.claude-cpp-style');
  fs.mkdirSync(cfgDir3, { recursive: true });
  fs.writeFileSync(path.join(cfgDir3, 'cpp-style.json'), JSON.stringify({ enabled: false }));
  const src3 = path.join(proj3, 'c.cpp');
  fs.writeFileSync(src3, 'int c;');
  assert.strictEqual(loadConfig(src3, userPath).enabled, false, 'enabled:false 透传');

  console.log('config.test.js PASS');
} finally {
  for (const d of cleanupDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
}
