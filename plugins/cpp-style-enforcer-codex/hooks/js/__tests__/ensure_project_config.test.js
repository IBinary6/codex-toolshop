const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureProjectConfig } = require('../lib/ensure_project_config.js');
const { DEFAULT_CONFIG } = require('../lib/config.js');

function sh(args, cwd) { spawnSync('git', args, { cwd, stdio: 'pipe' }); }

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const tmps = [];
function mkRepo() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'projcfg-'));
  tmps.push(t);
  sh(['init'], t);
  return t;
}
function relPath(root) { return path.join(root, '.codex-cpp-style', 'cpp-style.json'); }

try {
  // 1. 无项目配置 + 有全局模板 → 生成 Codex 路径，内容来自全局模板，无 BOM
  {
    const root = mkRepo();
    const tplDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
    tmps.push(tplDir);
    const tpl = path.join(tplDir, 'cpp-style-template.json');
    const tplContent = JSON.stringify({ enabled: true, mode: 'full', checks: { clangFormat: true } }, null, 2) + '\n';
    fs.writeFileSync(tpl, Buffer.from(tplContent, 'utf-8'));

    ensureProjectConfig(root, tpl);
    const p = relPath(root);
    assert.ok(fs.existsSync(p), '应生成 cpp-style.json');
    const buf = fs.readFileSync(p);
    assert.ok(!buf.subarray(0, 3).equals(BOM), '生成文件无 BOM');
    assert.strictEqual(buf.toString('utf-8'), tplContent, '内容来自全局模板（逐字一致）');
    const parsed = JSON.parse(buf.toString('utf-8'));
    assert.strictEqual(parsed.mode, 'full', '模板字段保留');
  }

  // 2. 全局模板缺失 → 用硬编码默认 schema
  {
    const root = mkRepo();
    const missing = path.join(os.tmpdir(), 'nonexistent-tpl-xyz.json');
    ensureProjectConfig(root, missing);
    const p = relPath(root);
    assert.ok(fs.existsSync(p), '模板缺失也生成');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    assert.deepStrictEqual(parsed, DEFAULT_CONFIG, '内容为硬编码默认 schema');
  }

  // 3. 全局模板损坏（非法 JSON）→ 回退默认 schema
  {
    const root = mkRepo();
    const tplDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tplbad-'));
    tmps.push(tplDir);
    const tpl = path.join(tplDir, 'bad.json');
    fs.writeFileSync(tpl, '{ not valid json', 'utf-8');
    ensureProjectConfig(root, tpl);
    const parsed = JSON.parse(fs.readFileSync(relPath(root), 'utf-8'));
    assert.deepStrictEqual(parsed, DEFAULT_CONFIG, '损坏模板回退默认 schema');
  }

  // 4. 已存在 cpp-style.json → 字节不变，绝不覆盖
  {
    const root = mkRepo();
    const dir = path.join(root, '.codex-cpp-style');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'cpp-style.json');
    const custom = Buffer.from('{"enabled":false,"mode":"full"}\n', 'utf-8');
    fs.writeFileSync(p, custom);
    ensureProjectConfig(root); // 用默认模板路径，不应触发写
    assert.ok(fs.readFileSync(p).equals(custom), '已存在则字节不变不覆盖');
  }

  // 5. 旧 Claude 路径已存在 → 不生成 Codex 路径、不覆盖旧配置
  {
    const root = mkRepo();
    const dir = path.join(root, '.claude-cpp-style');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = path.join(dir, 'cpp-style.json');
    fs.writeFileSync(legacy, '{"enabled":false}\n', 'utf-8');
    ensureProjectConfig(root);
    assert.ok(!fs.existsSync(relPath(root)), '旧配置存在时不额外生成 Codex 配置');
    assert.strictEqual(fs.readFileSync(legacy, 'utf-8'), '{"enabled":false}\n');
  }

  // 6. 非 git（root=null）→ 不生成、不崩
  {
    assert.doesNotThrow(() => ensureProjectConfig(null), 'root=null 不应抛出');
  }

  console.log('ensure_project_config.test.js PASS');
} finally {
  for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
}
