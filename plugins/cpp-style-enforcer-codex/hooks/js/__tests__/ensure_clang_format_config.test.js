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
  // 1. git 仓库无 .clang-format → 生成，含 BasedOnStyle: Google，无 BOM，LF
  {
    const root = mkRepo();
    ensureClangFormatConfig(root);
    const p = path.join(root, '.clang-format');
    assert.ok(fs.existsSync(p), '应生成 .clang-format');
    const buf = fs.readFileSync(p);
    assert.ok(!buf.subarray(0, 3).equals(BOM), '生成文件不应有 BOM');
    const txt = buf.toString('utf-8');
    assert.ok(/BasedOnStyle:\s*Google/.test(txt), '内容应含 BasedOnStyle: Google');
    assert.ok(!txt.includes('\r'), '应为 LF 换行');
  }

  // 2. 已有 .clang-format（用户自定义）→ 字节不变，绝不覆盖
  {
    const root = mkRepo();
    const p = path.join(root, '.clang-format');
    const custom = Buffer.from('BasedOnStyle: LLVM\nIndentWidth: 8\n', 'utf-8');
    fs.writeFileSync(p, custom);
    ensureClangFormatConfig(root);
    assert.ok(fs.readFileSync(p).equals(custom), '已存在 .clang-format 字节不变');
  }

  // 3. 已有 _clang-format（Windows 兼容名）→ 不生成 .clang-format
  {
    const root = mkRepo();
    const compat = path.join(root, '_clang-format');
    fs.writeFileSync(compat, 'BasedOnStyle: LLVM\n', 'utf-8');
    ensureClangFormatConfig(root);
    assert.ok(!fs.existsSync(path.join(root, '.clang-format')), '存在 _clang-format 时不生成 .clang-format');
  }

  // 4. 非 git（root=null）→ 不生成、不崩
  {
    assert.doesNotThrow(() => ensureClangFormatConfig(null), 'root=null 不应抛出');
  }

  console.log('ensure_clang_format_config.test.js PASS');
} finally {
  for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
}
