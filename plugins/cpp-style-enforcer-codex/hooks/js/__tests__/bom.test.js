const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyBom } = require('../steps/bom.js');

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bomstep-'));
function write(name, buf) { const p = path.join(tmp, name); fs.writeFileSync(p, buf); return p; }

try {
  // UTF-8 without BOM: add a BOM.
  const f1 = write('a.cpp', Buffer.from('int a;', 'utf-8'));
  applyBom(f1);
  let b1 = fs.readFileSync(f1);
  assert.ok(b1.slice(0, 3).equals(BOM), 'UTF-8 without BOM: add a BOM.');

  // Existing BOM: do not rewrite; mtime stays unchanged.
  const f2 = write('b.cpp', Buffer.concat([BOM, Buffer.from('int b;', 'utf-8')]));
  const m2 = fs.statSync(f2).mtimeMs;
  const before2 = fs.readFileSync(f2);
  applyBom(f2);
  assert.ok(fs.readFileSync(f2).equals(before2), 'Existing BOM content stays unchanged');
  assert.strictEqual(fs.statSync(f2).mtimeMs, m2, 'Existing BOM does not change mtime');

  // CMake projects also require a BOM.
  write('CMakeLists.txt', Buffer.from('project(x)\n', 'utf-8'));
  const f3 = write('c.cpp', Buffer.from('int c;', 'utf-8'));
  applyBom(f3);
  assert.ok(fs.readFileSync(f3).slice(0, 3).equals(BOM), 'CMake projects also add a BOM');

  // Empty file: write only a BOM.
  const f4 = write('d.cpp', Buffer.alloc(0));
  applyBom(f4);
  const b4 = fs.readFileSync(f4);
  assert.ok(b4.equals(BOM), 'Empty file gets only a BOM');

  // UTF-16: skip without changing bytes.
  const utf16 = Buffer.from([0xFF, 0xFE, 0x41, 0x00]);
  const f5 = write('e.cpp', utf16);
  applyBom(f5);
  assert.ok(fs.readFileSync(f5).equals(utf16), 'UTF-16 remains unchanged');

  // GBK: transcode and add BOM when iconv is available; otherwise classify unknown and leave intact.
  let iconvAvailable = false;
  try { require('iconv-lite'); iconvAvailable = true; } catch (_) {}
  const gbk = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]); // GBK-encoded "ni hao"
  const f6 = write('f.cpp', gbk);
  const ret6 = applyBom(f6);
  const b6 = fs.readFileSync(f6);
  if (iconvAvailable) {
    assert.ok(b6.slice(0, 3).equals(BOM), 'GBK gains a BOM');
    const iconv = require('iconv-lite');
    assert.strictEqual(b6.slice(3).toString('utf-8'), iconv.decode(gbk, 'gbk'), 'GBK is transcoded to UTF-8');
  } else {
    // Without iconv, detectEncoding classifies GBK bytes as unknown; do not add a BOM or change bytes.
    // The old behavior produced broken EF BB BF + GBK bytes in an otherwise readable GBK file.
    assert.strictEqual(ret6, false, 'Without iconv, GBK falls back to unknown and returns false');
    assert.ok(b6.equals(gbk), 'Without iconv, GBK bytes stay unchanged without a BOM');
  }

  // Unknown encoding: do not add a BOM; keep bytes and return false.
  // Construct bytes invalid as UTF-8 and unclassifiable as GBK without iconv.
  const raw = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3, 0x80, 0x81]);
  const f7 = write('g.cpp', raw);
  const ret7 = applyBom(f7);
  const b7 = fs.readFileSync(f7);
  if (!iconvAvailable) {
    // Without iconv, detectEncoding must return unknown.
    assert.strictEqual(ret7, false, 'Unknown encoding returns false');
    assert.ok(b7.equals(raw), 'Unknown encoding retains bytes without a BOM');
  }

  console.log('bom.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
