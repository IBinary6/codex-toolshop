const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runCpplint, formatViolations, parseCpplintOutput, buildFilterArg, MAX_ERRORS_SHOWN } = require('../steps/cpplint.js');

// ---- formatViolations：逐字去重后取前 5 + 「还有 N 条」----
const many = [];
for (let i = 1; i <= 8; i++) many.push({ line: i, category: 'whitespace/indent', message: `msg ${i}` });
many.push({ line: 1, category: 'whitespace/indent', message: 'msg 1' }); // 与首条逐字相同 → 去重
const reason = formatViolations(many);
assert.ok(reason.includes('msg 1') && reason.includes('msg 5'), '取前 5 条');
assert.ok(!reason.includes('msg 6'), '第 6 条不在前 5');
assert.ok(/还有 3 条/.test(reason), '去重后 8 条，显示 5 条，还有 3 条');
assert.strictEqual(MAX_ERRORS_SHOWN, 5, 'MAX_ERRORS_SHOWN=5');
assert.ok(/请修复/.test(reason), 'formatViolations 文案为「请修复」（硬违规）');

// 全相同条目 → 去重为 1 条，无「还有」
const dup = [
  { line: 2, category: 'build/include', message: 'same' },
  { line: 2, category: 'build/include', message: 'same' },
  { line: 2, category: 'build/include', message: 'same' },
];
const r2 = formatViolations(dup);
assert.ok(r2.includes('same'), '保留 1 条');
assert.ok(!/还有/.test(r2), '去重后仅 1 条无「还有」提示');

// ---- 软违规相关导出已删除：splitViolations/formatSoftViolations/SOFT_CATEGORIES 不再导出 ----
const cpplintMod = require('../steps/cpplint.js');
assert.strictEqual(cpplintMod.splitViolations, undefined, 'splitViolations 已删除');
assert.strictEqual(cpplintMod.formatSoftViolations, undefined, 'formatSoftViolations 已删除');
assert.strictEqual(cpplintMod.SOFT_CATEGORIES, undefined, 'SOFT_CATEGORIES 已删除');

// ---- parseCpplintOutput：解析 line/category/message ----
const sample = [
  '/tmp/x.cpp:0:  No copyright message found.  [legal/copyright] [5]',
  '/tmp/x.cpp:12:  Missing space before {  [whitespace/braces] [5]',
].join('\n');
const parsed = parseCpplintOutput(sample);
assert.strictEqual(parsed.length, 2, '解析 2 条');
assert.strictEqual(parsed[1].line, 12, 'line 解析');
assert.strictEqual(parsed[1].category, 'whitespace/braces', 'category 解析');
assert.ok(/Missing space/.test(parsed[1].message), 'message 解析');

// ---- buildFilterArg：无基础 filter 项，空时不传 --filter ----
assert.strictEqual(buildFilterArg({}), null, '无任何 filter 项时返回 null（调用方不传 --filter）');
assert.strictEqual(
  buildFilterArg({ suppressCopyright: true }),
  '--filter=-legal/copyright',
  'suppressCopyright 仅含 -legal/copyright',
);
assert.ok(
  !String(buildFilterArg({ suppressCopyright: false })).includes('--filter'),
  '不抑制版权且无额外项时无 --filter',
);

// ---- runCpplint：真实文件名下无误报 + 原文件零改动（需 python）----
const hasPython = spawnSync('python', ['--version'], { stdio: 'pipe' }).status === 0
  || spawnSync('python3', ['--version'], { stdio: 'pipe' }).status === 0;
if (hasPython) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpplint-'));
  try {
    // 构造真实项目结构（非 hash 临时名），root=tmp
    const src = path.join(tmp, 'proj', 'src');
    fs.mkdirSync(src, { recursive: true });

    // 1) 简单 cpp 零改动断言
    const f = path.join(src, 'main.cpp');
    const content = Buffer.from('int main() { return 0; }\n', 'utf-8');
    fs.writeFileSync(f, content);
    const before = fs.readFileSync(f);
    const viol = runCpplint(f, { root: tmp, suppressCopyright: true });
    assert.ok(Array.isArray(viol), 'runCpplint 返回数组');
    assert.ok(fs.readFileSync(f).equals(before), 'cpplint 步骤原文件字节零改动（无 BOM 零写入）');

    // 2) 真实文件名下正确 header guard 应 PASS（不误报 header_guard）
    //    --root=tmp → RepositoryName=proj/src/foo.h → 期望宏 PROJ_SRC_FOO_H_
    const fooH = path.join(src, 'foo.h');
    const guardOk = '#ifndef PROJ_SRC_FOO_H_\n#define PROJ_SRC_FOO_H_\n\nclass Foo {};\n\n#endif  // PROJ_SRC_FOO_H_\n';
    fs.writeFileSync(fooH, Buffer.from(guardOk, 'utf-8'));
    const vGuardOk = runCpplint(fooH, { root: tmp, suppressCopyright: true });
    assert.ok(
      !vGuardOk.some((v) => v.category === 'build/header_guard'),
      '真实路径下正确 guard 不误报 header_guard',
    );

    // 3) 错误的 guard 名（与真实路径不符）→ 仍能报 header_guard（真违规可报）
    const badH = path.join(src, 'bar.h');
    fs.writeFileSync(badH, Buffer.from('class Bar {};\n', 'utf-8'));
    const vBad = runCpplint(badH, { root: tmp, suppressCopyright: true });
    assert.ok(
      vBad.some((v) => v.category === 'build/header_guard'),
      '缺 guard 的头文件仍报 header_guard（真违规）',
    );

    // 4) 带 BOM 的正确 guard 头文件 → 不应误报 header_guard，且原文件 BOM 恢复
    const bomH = path.join(src, 'baz.h');
    const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
    const bazGuard = '#ifndef PROJ_SRC_BAZ_H_\n#define PROJ_SRC_BAZ_H_\n\nclass Baz {};\n\n#endif  // PROJ_SRC_BAZ_H_\n';
    const bomBytes = Buffer.concat([BOM, Buffer.from(bazGuard, 'utf-8')]);
    fs.writeFileSync(bomH, bomBytes);
    const vBom = runCpplint(bomH, { root: tmp, suppressCopyright: true });
    assert.ok(
      !vBom.some((v) => v.category === 'build/header_guard'),
      'BOM 头文件剥 BOM 后不误报 header_guard',
    );
    assert.ok(fs.readFileSync(bomH).equals(bomBytes), 'BOM 文件 lint 后原字节（含 BOM）恢复');

    // 5) suppressCopyright 开关
    const fc = path.join(src, 'nocopy.cpp');
    fs.writeFileSync(fc, Buffer.from('int main() { return 0; }\n', 'utf-8'));
    const vc = runCpplint(fc, { root: tmp, suppressCopyright: true });
    assert.ok(!vc.some((v) => v.category === 'legal/copyright'), 'suppressCopyright 屏蔽 legal/copyright');
    const vcWithCopy = runCpplint(fc, { root: tmp, suppressCopyright: false });
    assert.ok(vcWithCopy.some((v) => v.category === 'legal/copyright'), '不抑制时报 legal/copyright');

    console.log('cpplint.test.js PASS');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
} else {
  console.log('cpplint.test.js PASS (python absent, parse/format-only)');
}
