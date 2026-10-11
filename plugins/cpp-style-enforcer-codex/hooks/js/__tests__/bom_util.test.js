const assert = require('node:assert');
const { stripBom, restoreBom, detectEncoding } = require('../lib/bom_util.js');

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const body = Buffer.from('int main(){}', 'utf-8');

// Round trip with a BOM.
const withBom = Buffer.concat([BOM, body]);
let s = stripBom(withBom);
assert.strictEqual(s.hadBom, true, 'BOM should be detected');
assert.ok(s.body.equals(body), 'Body should exclude BOM');
assert.ok(restoreBom(s.hadBom, s.body).equals(withBom), 'Round trip preserves bytes with BOM');

// Round trip without a BOM.
s = stripBom(body);
assert.strictEqual(s.hadBom, false, 'No BOM');
assert.ok(restoreBom(s.hadBom, s.body).equals(body), 'Round trip preserves bytes without BOM');

// Normalize multiple leading BOMs to one.
const triple = Buffer.concat([BOM, BOM, BOM, body]);
s = stripBom(triple);
assert.strictEqual(s.hadBom, true, 'Multiple BOMs still set hadBom');
assert.ok(s.body.equals(body), 'All leading BOMs are stripped');
assert.ok(restoreBom(s.hadBom, s.body).equals(withBom), 'Multiple BOMs normalize to exactly one');

// detectEncoding classification.
assert.strictEqual(detectEncoding(withBom), 'utf-8-bom', 'UTF-8 BOM');
assert.strictEqual(detectEncoding(body), 'utf-8', 'No BOM UTF-8');
assert.strictEqual(detectEncoding(Buffer.from([0xFF, 0xFE, 0x41, 0x00])), 'utf-16', 'UTF-16 LE');
assert.strictEqual(detectEncoding(Buffer.from([0xFE, 0xFF, 0x00, 0x41])), 'utf-16', 'UTF-16 BE');
// GBK: high-bit bytes invalid as UTF-8 (0xC4 0xE3 encodes a Chinese character in GBK; other sequences also qualify).
const gbk = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]); // GBK-encoded "ni hao"
// Spec section 9: without iconv-lite, GBK detection falls back to unknown without throwing.
// Therefore this assertion accepts gbk with iconv-lite, or unknown without it.
let hasIconv = false;
try { require('iconv-lite'); hasIconv = true; } catch (_) {}
const gbkResult = detectEncoding(gbk);
if (hasIconv) {
  assert.strictEqual(gbkResult, 'gbk', 'GBK classified with iconv-lite');
} else {
  assert.strictEqual(gbkResult, 'unknown', 'GBK falls back to unknown without iconv-lite');
}
// Boundary: an empty buffer does not crash.
const empty = Buffer.from([]);
s = stripBom(empty);
assert.strictEqual(s.hadBom, false, 'Empty buffer has no BOM');
assert.strictEqual(s.body.length, 0, 'Empty buffer body has length zero');
assert.strictEqual(detectEncoding(empty), 'utf-8', 'detectEncoding handles an empty buffer');

// Boundary: only BOM bytes, with an empty body.
const onlyBom = Buffer.concat([BOM, BOM]);
s = stripBom(onlyBom);
assert.strictEqual(s.hadBom, true, 'BOM-only input has hadBom true');
assert.strictEqual(s.body.length, 0, 'BOM-only input has an empty body');
assert.ok(restoreBom(s.hadBom, s.body).equals(BOM), 'BOM-only round trip normalizes to one BOM');

// Slice isolation: mutating the original buffer must not change the copied body.
const mutSrc = Buffer.concat([BOM, body]);
const r = stripBom(mutSrc);
const bodySnapshot = Buffer.from(r.body); // Snapshot of the current body
mutSrc[3] = mutSrc[3] ^ 0xFF; // Corrupt the first body byte in the original buffer
assert.ok(r.body.equals(bodySnapshot), 'Body is independent of source buffer mutation');

// Slice isolation also applies without a BOM.
const mutSrc2 = Buffer.from(body);
const r2 = stripBom(mutSrc2);
const bodySnapshot2 = Buffer.from(r2.body);
mutSrc2[0] = mutSrc2[0] ^ 0xFF;
assert.ok(r2.body.equals(bodySnapshot2), 'Body is independent even without a BOM');

console.log('bom_util.test.js PASS');
