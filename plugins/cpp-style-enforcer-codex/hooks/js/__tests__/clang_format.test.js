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
    // Fallback: clang-format absent from PATH returns false silently and leaves the file untouched.
    const f = write('a.cpp', Buffer.from('int  main( ){return 0;}', 'utf-8'));
    const before = fs.readFileSync(f);
    const changed = applyClangFormat(f);
    assert.strictEqual(changed, false, 'Missing clang-format returns false');
    assert.ok(fs.readFileSync(f).equals(before), 'Missing clang-format leaves the file unchanged');
    console.log('clang_format.test.js PASS (clang-format absent, degrade-only)');
  } else {
    // A new VS file preserves dependency-sensitive include order even if project settings request sorting.
    const vsDir = path.join(tmp, 'vs');
    fs.mkdirSync(vsDir);
    fs.writeFileSync(path.join(vsDir, 'app.vcxproj'), '<Project />');
    fs.writeFileSync(path.join(vsDir, '.clang-format'), 'BasedOnStyle: Google\nSortIncludes: CaseSensitive\nIncludeBlocks: Regroup\n');
    const vsFile = path.join(vsDir, 'main.cpp');
    fs.writeFileSync(vsFile, '#include <windows.h>\n#include <LdsLog/lds_log.h>\n\nint  f( ){return 0;}\n');
    assert.strictEqual(applyClangFormat(vsFile, { isNew: true, root: vsDir }), true);
    const vsText = fs.readFileSync(vsFile, 'utf8');
    assert.ok(vsText.indexOf('<windows.h>') < vsText.indexOf('<LdsLog/lds_log.h>'));
    fs.rmSync(vsDir, { recursive: true, force: true });

    // Write when messy formatting changes.
    const messy = write('a.cpp', Buffer.from('int  main( ){return 0;}\n', 'utf-8'));
    const changed1 = applyClangFormat(messy);
    assert.strictEqual(changed1, true, 'Messy formatting is rewritten');

    // No change: a second formatter run does not write or change mtime.
    const m = fs.statSync(messy).mtimeMs;
    const changed2 = applyClangFormat(messy);
    assert.strictEqual(changed2, false, 'Compliant formatting is not rewritten');
    assert.strictEqual(fs.statSync(messy).mtimeMs, m, 'No change preserves mtime');

    // Formatting a BOM file keeps BOM as its first bytes.
    const messyBom = write('b.cpp', Buffer.concat([BOM, Buffer.from('int  x( ){return 1;}\n', 'utf-8')]));
    applyClangFormat(messyBom);
    const out = fs.readFileSync(messyBom);
    assert.ok(out.slice(0, 3).equals(BOM), 'Formatted BOM file retains leading BOM');
    assert.ok(!out.slice(3, 6).equals(BOM), 'BOM is not duplicated');

    // Large file: formatted stdout exceeds Node default 1 MB; without maxBuffer, ENOBUFS would silently skip it.
    // Build badly indented multiline code exceeding 1.5 MB after formatting to verify the 32 MB maxBuffer and successful write.
    const lines = [];
    lines.push('int big() {');
    for (let i = 0; i < 60000; i++) lines.push('    int  v' + i + '  =  ' + i + ' ;'); // Deliberately irregular spacing to format
    lines.push('  return 0 ;');
    lines.push('}');
    const bigSrc = Buffer.from(lines.join('\n') + '\n', 'utf-8');
    assert.ok(bigSrc.length > 1024 * 1024, 'Input exceeds the old 1 MB limit');
    const bigFile = write('big.cpp', bigSrc);
    const changedBig = applyClangFormat(bigFile);
    assert.strictEqual(changedBig, true, 'Large messy file is rewritten without silent ENOBUFS skip');
    const bigOut = fs.readFileSync(bigFile);
    assert.ok(bigOut.length > 1024 * 1024, 'Formatted large body remains over 1 MB without truncation');
    assert.ok(!bigOut.includes(Buffer.from('  =  ', 'utf-8')), 'Messy spacing was normalized');

    console.log('clang_format.test.js PASS');
  }

  // ---- Tracked-file mode: format changed lines only and never sort includes. ----
  if (hasClangFormat) {
    const gtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-git-'));
    function git(args) { spawnSync('git', args, { cwd: gtmp, stdio: 'pipe' }); }
    try {
      git(['init']);
      git(['config', 'user.email', 't@t.com']);
      git(['config', 'user.name', 't']);

      // Deliberately unsorted includes and a formatted function committed as HEAD baseline.
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

      // Change only line 5 indentation in function b, leaving includes on lines 1-2.
      const edited =
        '#include <zlib.h>\n' +
        '#include <abc.h>\n' +
        '\n' +
        'int a() { return 0; }\n' +
        'int    b()    {    return 1;    }\n';
      fs.writeFileSync(f, edited);

      const changed = applyClangFormat(f, { isNew: false, root });
      assert.strictEqual(changed, true, 'Changed lines in tracked file are formatted');
      const result = fs.readFileSync(f, 'utf-8').split('\n');
      // Keep include order (SortIncludes: Never).
      assert.strictEqual(result[0], '#include <zlib.h>', 'First include in tracked file stays unsorted');
      assert.strictEqual(result[1], '#include <abc.h>', 'Second include in tracked file stays unsorted');
      // Keep unchanged function a on line 4 intact.
      assert.strictEqual(result[3], 'int a() { return 0; }', 'Unchanged tracked-file line stays untouched');
      // Normalize changed function b on line 5.
      assert.strictEqual(result[4], 'int b() { return 1; }', 'Changed tracked-file line is normalized');

      // Even changed includes remain unsorted (SortIncludes: Never).
      const baseline2 = '#include <zlib.h>\n#include <abc.h>\nint a() { return 0; }\n';
      const f2 = path.join(gtmp, 'inc.cpp');
      fs.writeFileSync(f2, baseline2);
      git(['add', 'inc.cpp']);
      git(['commit', '-m', 'inc']);
      // Change spacing in a line 1 include so the edit is within the include section.
      const edited2 = '#include    <zlib.h>\n#include <abc.h>\nint a() { return 0; }\n';
      fs.writeFileSync(f2, edited2);
      applyClangFormat(f2, { isNew: false, root });
      const r2 = fs.readFileSync(f2, 'utf-8').split('\n');
      assert.strictEqual(r2[0], '#include <zlib.h>', 'Changed include area still keeps zlib first');
      assert.strictEqual(r2[1], '#include <abc.h>', 'Changed include area still keeps abc second');

      // No changed lines: skip formatting and return false.
      const f3 = path.join(gtmp, 'nochange.cpp');
      fs.writeFileSync(f3, 'int  m( ){return 0;}\n'); // Irregular formatting that matches HEAD
      git(['add', 'nochange.cpp']);
      git(['commit', '-m', 'nochange']);
      const beforeNc = fs.readFileSync(f3);
      const changedNc = applyClangFormat(f3, { isNew: false, root });
      assert.strictEqual(changedNc, false, 'Tracked file without changed lines skips formatting');
      assert.ok(fs.readFileSync(f3).equals(beforeNc), 'Tracked file without changed lines stays unchanged');

      // Tracked files must use project four-space indentation rather than an inline Google fallback.
      fs.writeFileSync(path.join(gtmp, '.clang-format'),
        'BasedOnStyle: LLVM\nIndentWidth: 4\nAllowShortFunctionsOnASingleLine: None\n');
      const configured = path.join(gtmp, 'configured.cpp');
      fs.writeFileSync(configured, 'int configured() {\n    return 1;\n}\n');
      git(['add', 'configured.cpp']);
      git(['commit', '-m', 'configured']);
      fs.writeFileSync(configured, 'int configured() {\n return    2;\n}\n');
      assert.strictEqual(applyClangFormat(configured, { isNew: false, root }), true);
      assert.strictEqual(fs.readFileSync(configured, 'utf8'), 'int configured() {\n    return 2;\n}\n');

      console.log('clang_format.test.js old-file mode PASS');
    } finally {
      fs.rmSync(gtmp, { recursive: true, force: true });
    }
  }
} finally {
  for (const p of created) { try { fs.unlinkSync(p); } catch (_) {} }
  try { fs.rmdirSync(tmp); } catch (_) {}
}
