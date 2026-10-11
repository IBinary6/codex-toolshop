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
  // 1. No project config with global template: generate Codex path from template without BOM.
  {
    const root = mkRepo();
    const tplDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
    tmps.push(tplDir);
    const tpl = path.join(tplDir, 'cpp-style-template.json');
    const tplContent = JSON.stringify({ enabled: true, mode: 'full', checks: { clangFormat: true } }, null, 2) + '\n';
    fs.writeFileSync(tpl, Buffer.from(tplContent, 'utf-8'));

    ensureProjectConfig(root, tpl);
    const p = relPath(root);
    assert.ok(fs.existsSync(p), 'Generate cpp-style.json');
    const buf = fs.readFileSync(p);
    assert.ok(!buf.subarray(0, 3).equals(BOM), 'Generated file has no BOM');
    assert.strictEqual(buf.toString('utf-8'), tplContent, 'Content exactly matches the global template');
    const parsed = JSON.parse(buf.toString('utf-8'));
    assert.strictEqual(parsed.mode, 'full', 'Template fields are preserved');
  }

  // 2. Missing global template: use hard-coded default schema.
  {
    const root = mkRepo();
    const missing = path.join(os.tmpdir(), 'nonexistent-tpl-xyz.json');
    ensureProjectConfig(root, missing);
    const p = relPath(root);
    assert.ok(fs.existsSync(p), 'Generate even without a template');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    assert.deepStrictEqual(parsed, DEFAULT_CONFIG, 'Content uses hard-coded default schema');
  }

  // 3. Invalid global template JSON: fall back to default schema.
  {
    const root = mkRepo();
    const tplDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tplbad-'));
    tmps.push(tplDir);
    const tpl = path.join(tplDir, 'bad.json');
    fs.writeFileSync(tpl, '{ not valid json', 'utf-8');
    ensureProjectConfig(root, tpl);
    const parsed = JSON.parse(fs.readFileSync(relPath(root), 'utf-8'));
    assert.deepStrictEqual(parsed, DEFAULT_CONFIG, 'Invalid template falls back to default schema');
  }

  // 4. Existing cpp-style.json: preserve bytes and never overwrite.
  {
    const root = mkRepo();
    const dir = path.join(root, '.codex-cpp-style');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'cpp-style.json');
    const custom = Buffer.from('{"enabled":false,"mode":"full"}\n', 'utf-8');
    fs.writeFileSync(p, custom);
    ensureProjectConfig(root); // Use default template path without writing.
    assert.ok(fs.readFileSync(p).equals(custom), 'Existing configuration stays byte-identical');
  }

  // 5. Existing legacy Claude path: do not generate Codex path or overwrite it.
  {
    const root = mkRepo();
    const dir = path.join(root, '.claude-cpp-style');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = path.join(dir, 'cpp-style.json');
    fs.writeFileSync(legacy, '{"enabled":false}\n', 'utf-8');
    ensureProjectConfig(root);
    assert.ok(!fs.existsSync(relPath(root)), 'Legacy configuration prevents extra Codex config');
    assert.strictEqual(fs.readFileSync(legacy, 'utf-8'), '{"enabled":false}\n');
  }

  // 6. Outside Git (root=null): do not generate or crash.
  {
    assert.doesNotThrow(() => ensureProjectConfig(null), 'root=null must not throw');
  }

  console.log('ensure_project_config.test.js PASS');
} finally {
  for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
}
