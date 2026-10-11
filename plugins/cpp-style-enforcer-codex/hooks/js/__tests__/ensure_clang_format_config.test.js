const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureClangFormatConfig } = require('../lib/ensure_clang_format_config.js');

function sh(args, cwd) { spawnSync('git', args, { cwd, stdio: 'pipe' }); }

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

const tmps = [];
function mkRepo() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'clangfmt-'));
  tmps.push(t);
  sh(['init'], t);
  return t;
}

try {
  // 1. Git repository without .clang-format: generate Google style using LF and no BOM.
  {
    const root = mkRepo();
    ensureClangFormatConfig(root);
    const p = path.join(root, '.clang-format');
    assert.ok(fs.existsSync(p), 'Generate .clang-format');
    const buf = fs.readFileSync(p);
    assert.ok(!buf.subarray(0, 3).equals(BOM), 'Generated file has no BOM');
    const txt = buf.toString('utf-8');
    assert.ok(/BasedOnStyle:\s*Google/.test(txt), 'Content includes BasedOnStyle: Google');
    assert.ok(!txt.includes('\r'), 'Use LF endings');
  }

  // 2. Existing custom .clang-format: keep bytes and never overwrite.
  {
    const root = mkRepo();
    const p = path.join(root, '.clang-format');
    const custom = Buffer.from('BasedOnStyle: LLVM\nIndentWidth: 8\n', 'utf-8');
    fs.writeFileSync(p, custom);
    ensureClangFormatConfig(root);
    assert.ok(fs.readFileSync(p).equals(custom), 'Existing .clang-format stays byte-identical');
  }

  // 3. Existing _clang-format (Windows-compatible): do not generate .clang-format.
  {
    const root = mkRepo();
    const compat = path.join(root, '_clang-format');
    fs.writeFileSync(compat, 'BasedOnStyle: LLVM\n', 'utf-8');
    ensureClangFormatConfig(root);
    assert.ok(!fs.existsSync(path.join(root, '.clang-format')), 'Do not generate .clang-format when _clang-format exists');
  }

  // 4. Outside Git (root=null): do not generate or crash.
  {
    assert.doesNotThrow(() => ensureClangFormatConfig(null), 'root=null must not throw');
  }

  // 5. Do not mask an inherited parent style with a new repository-root default.
  {
    const parent = mkRepo();
    const root = path.join(parent, 'nested');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(parent, '.clang-format'), 'BasedOnStyle: LLVM\nIndentWidth: 4\n');
    ensureClangFormatConfig(root);
    assert.ok(!fs.existsSync(path.join(root, '.clang-format')), 'Preserve inherited parent configuration');
  }

  console.log('ensure_clang_format_config.test.js PASS');
} finally {
  for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
}
