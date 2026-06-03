const assert = require('node:assert');
const { stripBom, restoreBom, detectEncoding } = require('../lib/bom_util.js');

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const body = Buffer.from('int main(){}', 'utf-8');

// 往返：带 BOM
const withBom = Buffer.concat([BOM, body]);
let s = stripBom(withBom);
assert.strictEqual(s.hadBom, true, '应检出 BOM');
assert.ok(s.body.equals(body), 'body 应去掉 BOM');
assert.ok(restoreBom(s.hadBom, s.body).equals(withBom), '往返字节级一致(带BOM)');

// 往返：不带 BOM
s = stripBom(body);
assert.strictEqual(s.hadBom, false, '无 BOM');
assert.ok(restoreBom(s.hadBom, s.body).equals(body), '往返字节级一致(无BOM)');

// 多前导 BOM 归一为一个
const triple = Buffer.concat([BOM, BOM, BOM, body]);
s = stripBom(triple);
assert.strictEqual(s.hadBom, true, '多 BOM 仍 hadBom=true');
assert.ok(s.body.equals(body), '多 BOM 全部剥掉');
assert.ok(restoreBom(s.hadBom, s.body).equals(withBom), '多 BOM 归一为恰好一个');

// detectEncoding 分类
assert.strictEqual(detectEncoding(withBom), 'utf-8-bom', 'UTF-8 BOM');
assert.strictEqual(detectEncoding(body), 'utf-8', '无 BOM UTF-8');
assert.strictEqual(detectEncoding(Buffer.from([0xFF, 0xFE, 0x41, 0x00])), 'utf-16', 'UTF-16 LE');
assert.strictEqual(detectEncoding(Buffer.from([0xFE, 0xFF, 0x00, 0x41])), 'utf-16', 'UTF-16 BE');
// GBK：含高位字节但非合法 UTF-8（0xC4 0xE3 = "你" 的 GBK，但单独 0xD0 0xE3 等）
const gbk = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]); // "你好" GBK
// spec §9：iconv-lite 缺失 → GBK 检测降级为 'unknown'（被 try/catch 吞）。
// 故此断言容忍 'gbk'（iconv-lite 可用）或 'unknown'（iconv-lite 缺失）。
let hasIconv = false;
try { require('iconv-lite'); hasIconv = true; } catch (_) {}
const gbkResult = detectEncoding(gbk);
if (hasIconv) {
  assert.strictEqual(gbkResult, 'gbk', 'GBK 分类（iconv-lite 可用）');
} else {
  assert.strictEqual(gbkResult, 'unknown', 'GBK 降级 unknown（iconv-lite 缺失）');
}
// 边界：空 buffer 不崩
const empty = Buffer.from([]);
s = stripBom(empty);
assert.strictEqual(s.hadBom, false, '空 buffer 无 BOM');
assert.strictEqual(s.body.length, 0, '空 buffer body 长度 0');
assert.strictEqual(detectEncoding(empty), 'utf-8', '空 buffer detectEncoding 不崩');

// 边界：全是 BOM 无正文（body 长度 0）
const onlyBom = Buffer.concat([BOM, BOM]);
s = stripBom(onlyBom);
assert.strictEqual(s.hadBom, true, '全 BOM hadBom=true');
assert.strictEqual(s.body.length, 0, '全 BOM body 长度 0');
assert.ok(restoreBom(s.hadBom, s.body).equals(BOM), '全 BOM 往返归一为一个 BOM');

// slice 隔离回归：改原始 buf，body 内容必须不变（验证独立副本）
const mutSrc = Buffer.concat([BOM, body]);
const r = stripBom(mutSrc);
const bodySnapshot = Buffer.from(r.body); // 当前 body 内容快照
mutSrc[3] = mutSrc[3] ^ 0xFF; // 篡改原 buf 正文首字节
assert.ok(r.body.equals(bodySnapshot), 'body 不随原 buf 改动而变（独立内存）');

// slice 隔离回归：无 BOM 分支也需独立
const mutSrc2 = Buffer.from(body);
const r2 = stripBom(mutSrc2);
const bodySnapshot2 = Buffer.from(r2.body);
mutSrc2[0] = mutSrc2[0] ^ 0xFF;
assert.ok(r2.body.equals(bodySnapshot2), '无 BOM 分支 body 也独立');

console.log('bom_util.test.js PASS');
