const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCpplint, formatViolations, parseCpplintOutput, buildFilterArg, MAX_ERRORS_SHOWN } = require('../steps/cpplint.js');
const { resolvePython } = require('../lib/python');

// ---- formatViolations: exact deduplication, first five, and a remaining count.----
const many = [];
for (let i = 1; i <= 8; i++) many.push({ line: i, category: 'whitespace/indent', message: `msg ${i}` });
many.push({ line: 1, category: 'whitespace/indent', message: 'msg 1' }); // Exactly matches the first entry, so deduplicate.
const reason = formatViolations(many);
assert.ok(reason.includes('msg 1') && reason.includes('msg 5'), 'Show the first five entries');
assert.ok(!reason.includes('msg 6'), 'Do not show the sixth entry');
assert.ok(/3 more violations/.test(reason), 'Eight unique entries: show five and report three more');
assert.strictEqual(MAX_ERRORS_SHOWN, 5, 'MAX_ERRORS_SHOWN=5');
assert.ok(/please fix/.test(reason), 'formatViolations asks for repair of hard violations');

// Identical entries deduplicate to one without a remaining count.
const dup = [
  { line: 2, category: 'build/include', message: 'same' },
  { line: 2, category: 'build/include', message: 'same' },
  { line: 2, category: 'build/include', message: 'same' },
];
const r2 = formatViolations(dup);
assert.ok(r2.includes('same'), 'Keep one entry');
assert.ok(!/more violations/.test(r2), 'One unique entry has no remaining-count hint');

const multiFile = formatViolations([
  { file: 'src/a.cpp', line: 3, category: 'whitespace/braces', message: 'bad' },
  { file: 'src/b.cpp', line: 3, category: 'whitespace/braces', message: 'bad' },
]);
assert.ok(multiFile.includes('src/a.cpp:3'), 'Multi-file output includes file a');
assert.ok(multiFile.includes('src/b.cpp:3'), 'Multi-file output includes file b');

// ---- Soft-violation exports were removed: no splitViolations/formatSoftViolations/SOFT_CATEGORIES. ----
const cpplintMod = require('../steps/cpplint.js');
assert.strictEqual(cpplintMod.splitViolations, undefined, 'splitViolations export was removed');
assert.strictEqual(cpplintMod.formatSoftViolations, undefined, 'formatSoftViolations export was removed');
assert.strictEqual(cpplintMod.SOFT_CATEGORIES, undefined, 'SOFT_CATEGORIES export was removed');

// ---- parseCpplintOutput parses line/category/message. ----
const sample = [
  '/tmp/x.cpp:0:  No copyright message found.  [legal/copyright] [5]',
  '/tmp/x.cpp:12:  Missing space before {  [whitespace/braces] [5]',
].join('\n');
const parsed = parseCpplintOutput(sample);
assert.strictEqual(parsed.length, 2, 'Parse two entries');
assert.strictEqual(parsed[1].line, 12, 'Parse line');
assert.strictEqual(parsed[1].category, 'whitespace/braces', 'Parse category');
assert.ok(/Missing space/.test(parsed[1].message), 'Parse message');

// ---- buildFilterArg retains team filters and optionally excludes copyright. ----
assert.strictEqual(
  buildFilterArg({}),
  '--filter=-whitespace/indent_namespace',
  'Exclude the default namespace indentation false positive',
);
assert.strictEqual(
  buildFilterArg({ suppressCopyright: true }),
  '--filter=-whitespace/indent_namespace,-legal/copyright',
  'suppressCopyright adds -legal/copyright',
);
assert.ok(
  String(buildFilterArg({ suppressCopyright: false })).includes('-whitespace/indent_namespace'),
  'Default team filters remain when copyright is not excluded',
);
assert.ok(buildFilterArg({ preserveIncludeOrder: true }).includes('-build/include_order'));
assert.ok(!buildFilterArg({}).includes('-build/include_order'));

// Runtime failure cannot masquerade as zero violations; this case needs no local Python or Git.
assert.ok(runCpplint(__filename, { resolvePython: () => null })
  .some((item) => item.category === 'runtime/cpplint'));
for (const result of [
  { status: 7, stderr: Buffer.from('Traceback: linter failed') },
  { status: null, signal: 'SIGTERM' },
  { error: { code: 'ENOENT' } },
  { status: 0, stderr: Buffer.from('Line length must be numeric.') },
]) {
  const violations = runCpplint(__filename, {
    resolvePython: () => ({ cmd: 'test-python', args: [] }),
    spawnSync: () => result,
  });
  assert.ok(violations.some((item) => item.category === 'runtime/cpplint'));
}

// ---- runCpplint: no false positives with real filename and no source changes (requires Python).----
const hasPython = resolvePython() !== null;
if (hasPython) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpplint-'));
  try {
    // Create a real project structure rather than hashed temporary filenames; root=tmp.
    const src = path.join(tmp, 'proj', 'src');
    fs.mkdirSync(src, { recursive: true });

    // 1) Assert a simple .cpp remains unchanged.
    const f = path.join(src, 'main.cpp');
    const content = Buffer.from('int main() { return 0; }\n', 'utf-8');
    fs.writeFileSync(f, content);
    const before = fs.readFileSync(f);
    const viol = runCpplint(f, { root: tmp, suppressCopyright: true });
    assert.ok(Array.isArray(viol), 'runCpplint returns an array');
    assert.ok(fs.readFileSync(f).equals(before), 'The cpplint step leaves the original bytes unchanged, including a file without a BOM');

    // 1b) CRLF is a project/platform ending policy; cpplint must neither flag nor rewrite it.
    const crlfCpp = path.join(src, 'crlf.cpp');
    const crlfBytes = Buffer.from('int crlf() {\r\n  return 0;\r\n}\r\n', 'utf-8');
    fs.writeFileSync(crlfCpp, crlfBytes);
    const vCrlf = runCpplint(crlfCpp, { root: tmp, suppressCopyright: true });
    assert.ok(
      !vCrlf.some((v) => v.category === 'whitespace/newline' || v.category === 'whitespace/ending_newline'),
      'CRLF must not trigger a cpplint newline false positive',
    );
    assert.ok(fs.readFileSync(crlfCpp).equals(crlfBytes), 'CRLF file bytes are unchanged after lint');

    // 2) A correct header guard at the real path passes without false diagnostics.
    //    --root=tmp → RepositoryName=proj/src/foo.h → Expected macro PROJ_SRC_FOO_H_
    const fooH = path.join(src, 'foo.h');
    const guardOk = '#ifndef PROJ_SRC_FOO_H_\n#define PROJ_SRC_FOO_H_\n\nclass Foo {};\n\n#endif  // PROJ_SRC_FOO_H_\n';
    fs.writeFileSync(fooH, Buffer.from(guardOk, 'utf-8'));
    const vGuardOk = runCpplint(fooH, { root: tmp, suppressCopyright: true });
    assert.ok(
      !vGuardOk.some((v) => v.category === 'build/header_guard'),
      'Correct guard at the real path avoids a false header_guard warning',
    );

    // 3) A wrong guard for the real path still produces a genuine header_guard violation.
    const badH = path.join(src, 'bar.h');
    fs.writeFileSync(badH, Buffer.from('class Bar {};\n', 'utf-8'));
    const vBad = runCpplint(badH, { root: tmp, suppressCopyright: true });
    assert.ok(
      vBad.some((v) => v.category === 'build/header_guard'),
      'A missing guard still reports a genuine header_guard violation',
    );

    // 4) A correct guarded header with BOM has no false header_guard diagnostic and retains its BOM.
    const bomH = path.join(src, 'baz.h');
    const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
    const bazGuard = '#ifndef PROJ_SRC_BAZ_H_\r\n#define PROJ_SRC_BAZ_H_\r\n\r\nclass Baz {};\r\n\r\n#endif  // PROJ_SRC_BAZ_H_\r\n';
    const bomBytes = Buffer.concat([BOM, Buffer.from(bazGuard, 'utf-8')]);
    fs.writeFileSync(bomH, bomBytes);
    fs.utimesSync(bomH, new Date(1000000), new Date(1000000));
    const bomMtime = fs.statSync(bomH).mtimeMs;
    const vBom = runCpplint(bomH, { root: tmp, suppressCopyright: true });
    assert.ok(
      !vBom.some((v) => v.category === 'build/header_guard'),
      'BOM header avoids false header_guard diagnostics',
    );
    assert.ok(fs.readFileSync(bomH).equals(bomBytes), 'BOM and CRLF bytes remain intact after lint');
    assert.strictEqual(fs.statSync(bomH).mtimeMs, bomMtime, 'BOM linting must not write the file');

    // 5) suppressCopyright switch.
    const fc = path.join(src, 'nocopy.cpp');
    fs.writeFileSync(fc, Buffer.from('int main() { return 0; }\n', 'utf-8'));
    const vc = runCpplint(fc, { root: tmp, suppressCopyright: true });
    assert.ok(!vc.some((v) => v.category === 'legal/copyright'), 'suppressCopyright excludes legal/copyright');
    const vcWithCopy = runCpplint(fc, { root: tmp, suppressCopyright: false });
    assert.ok(vcWithCopy.some((v) => v.category === 'legal/copyright'), 'Without suppression, legal/copyright is reported');

    console.log('cpplint.test.js PASS');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
} else {
  console.log('cpplint.test.js PASS (python absent, parse/format-only)');
}
