const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { applyClangFormat } = require('../steps/clang_format.js');

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
const created = [];
function write(name, buf) { const p = path.join(tmp, name); fs.writeFileSync(p, buf); created.push(p); return p; }

try {
  const hasClangFormat = spawnSync('clang-format', ['--version'], { stdio: 'pipe' }).status === 0;

  if (!hasClangFormat) {
    // 降级分支：clang-format 不在 PATH → 静默返回 false，文件不动
    const f = write('a.cpp', Buffer.from('int  main( ){return 0;}', 'utf-8'));
    const before = fs.readFileSync(f);
    const changed = applyClangFormat(f);
    assert.strictEqual(changed, false, 'clang-format 缺失 → 返回 false');
    assert.ok(fs.readFileSync(f).equals(before), 'clang-format 缺失 → 文件不动');
    console.log('clang_format.test.js PASS (clang-format absent, degrade-only)');
  } else {
    // 有变化 → 写回（杂乱格式被规范化）
    const messy = write('a.cpp', Buffer.from('int  main( ){return 0;}\n', 'utf-8'));
    const changed1 = applyClangFormat(messy);
    assert.strictEqual(changed1, true, '杂乱格式 → 有变化写回');

    // 无变化 → 不写回（mtime 不变）：先格式化一次，再跑一次应无变化
    const m = fs.statSync(messy).mtimeMs;
    const changed2 = applyClangFormat(messy);
    assert.strictEqual(changed2, false, '已规范 → 无变化不写回');
    assert.strictEqual(fs.statSync(messy).mtimeMs, m, '无变化 mtime 不变');

    // 带 BOM 文件格式化后 BOM 仍是首字节
    const messyBom = write('b.cpp', Buffer.concat([BOM, Buffer.from('int  x( ){return 1;}\n', 'utf-8')]));
    applyClangFormat(messyBom);
    const out = fs.readFileSync(messyBom);
    assert.ok(out.slice(0, 3).equals(BOM), '带 BOM 格式化后 BOM 仍首字节');
    assert.ok(!out.slice(3, 6).equals(BOM), 'BOM 不重复');

    // 大文件：格式化后 stdout > Node 默认 1MB。无 maxBuffer 会 ENOBUFS 被静默跳过。
    // 这里构造缩进混乱的多行代码，格式化后正文 > 1.5MB，验证 maxBuffer(32MB) 生效、大文件能正常写回。
    const lines = [];
    lines.push('int big() {');
    for (let i = 0; i < 60000; i++) lines.push('    int  v' + i + '  =  ' + i + ' ;'); // 每行混乱空格，待规范化
    lines.push('  return 0 ;');
    lines.push('}');
    const bigSrc = Buffer.from(lines.join('\n') + '\n', 'utf-8');
    assert.ok(bigSrc.length > 1024 * 1024, '构造的输入应 > 1MB 以触发旧 1MB 上限');
    const bigFile = write('big.cpp', bigSrc);
    const changedBig = applyClangFormat(bigFile);
    assert.strictEqual(changedBig, true, '大文件杂乱格式 → 不被 ENOBUFS 静默跳过，正常写回');
    const bigOut = fs.readFileSync(bigFile);
    assert.ok(bigOut.length > 1024 * 1024, '格式化后大文件正文仍 > 1MB（确认整段被写回，未截断）');
    assert.ok(!bigOut.includes(Buffer.from('  =  ', 'utf-8')), '混乱空格已被规范化');

    console.log('clang_format.test.js PASS');
  }

  // ---- 老文件模式：仅格改动行 + include 永不排序 ----
  if (hasClangFormat) {
    const gtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-git-'));
    function git(args) { spawnSync('git', args, { cwd: gtmp, stdio: 'pipe' }); }
    try {
      git(['init']);
      git(['config', 'user.email', 't@t.com']);
      git(['config', 'user.name', 't']);

      // include 区故意乱序 + 已规范的函数；提交为 HEAD（老文件基线）
      const baseline =
        '#include <zlib.h>\n' +
        '#include <abc.h>\n' +
        '\n' +
        'int a() { return 0; }\n' +
        'int b() { return 1; }\n';
      const f = path.join(gtmp, 'old.cpp');
      fs.writeFileSync(f, baseline);
      git(['add', 'old.cpp']);
      git(['commit', '-m', 'init']);
      const root = gtmp;

      // 仅改第 5 行（b 函数）缩进，include 区(1-2 行)不碰
      const edited =
        '#include <zlib.h>\n' +
        '#include <abc.h>\n' +
        '\n' +
        'int a() { return 0; }\n' +
        'int    b()    {    return 1;    }\n';
      fs.writeFileSync(f, edited);

      const changed = applyClangFormat(f, { isNew: false, root });
      assert.strictEqual(changed, true, '老文件改动行有杂乱空格 → 格式化写回');
      const result = fs.readFileSync(f, 'utf-8').split('\n');
      // include 顺序保持原样（SortIncludes:Never）
      assert.strictEqual(result[0], '#include <zlib.h>', '老文件 include 第1行不变(不排序)');
      assert.strictEqual(result[1], '#include <abc.h>', '老文件 include 第2行不变(不排序)');
      // 第 4 行(未改动的 a 函数)保持原样
      assert.strictEqual(result[3], 'int a() { return 0; }', '老文件未改动行不被格式化');
      // 第 5 行(改动的 b 函数)被规范化
      assert.strictEqual(result[4], 'int b() { return 1; }', '老文件改动行被规范化');

      // include 区本身被改动 → 仍不排序（SortIncludes:Never 生效）
      const baseline2 = '#include <zlib.h>\n#include <abc.h>\nint a() { return 0; }\n';
      const f2 = path.join(gtmp, 'inc.cpp');
      fs.writeFileSync(f2, baseline2);
      git(['add', 'inc.cpp']);
      git(['commit', '-m', 'inc']);
      // 改第 1 行 include 的空格(制造改动落在 include 区)
      const edited2 = '#include    <zlib.h>\n#include <abc.h>\nint a() { return 0; }\n';
      fs.writeFileSync(f2, edited2);
      applyClangFormat(f2, { isNew: false, root });
      const r2 = fs.readFileSync(f2, 'utf-8').split('\n');
      assert.strictEqual(r2[0], '#include <zlib.h>', '改动落在 include 区也不排序: 第1行仍 zlib');
      assert.strictEqual(r2[1], '#include <abc.h>', '改动落在 include 区也不排序: 第2行仍 abc');

      // 无改动行 → 不格式化，返回 false
      const f3 = path.join(gtmp, 'nochange.cpp');
      fs.writeFileSync(f3, 'int  m( ){return 0;}\n'); // 杂乱但等于 HEAD
      git(['add', 'nochange.cpp']);
      git(['commit', '-m', 'nochange']);
      const beforeNc = fs.readFileSync(f3);
      const changedNc = applyClangFormat(f3, { isNew: false, root });
      assert.strictEqual(changedNc, false, '老文件无改动行 → 不格式化返回 false');
      assert.ok(fs.readFileSync(f3).equals(beforeNc), '老文件无改动行 → 内容不动');

      console.log('clang_format.test.js old-file mode PASS');
    } finally {
      fs.rmSync(gtmp, { recursive: true, force: true });
    }
  }
} finally {
  for (const p of created) { try { fs.unlinkSync(p); } catch (_) {} }
  try { fs.rmdirSync(tmp); } catch (_) {}
}