'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveLineEnding, normalizeLineEndings, applyLineEndings } = require('../lib/line_endings');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-eol-'));
function write(name, content = '') {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
try {
  write('vs/app.vcxproj');
  const vs = write('vs/src/main.cpp', 'int x;\nint y;');
  assert.equal(resolveLineEnding(vs, fs.readFileSync(vs), { lineEnding: 'lf' }, tmp), '\r\n');
  assert.equal(applyLineEndings(vs, '\r\n'), true);
  assert.deepEqual(fs.readFileSync(vs), Buffer.from('int x;\r\nint y;\r\n'));
  const mtime = fs.statSync(vs).mtimeMs;
  assert.equal(applyLineEndings(vs, '\r\n'), false);
  assert.equal(fs.statSync(vs).mtimeMs, mtime);

  write('vs/vendor/CMakeLists.txt');
  const cmake = write('vs/vendor/src/lib.cpp', 'int x;\n');
  assert.equal(resolveLineEnding(cmake, fs.readFileSync(cmake), {}, tmp), '\n', '嵌套 CMake 不继承外层 VS');
  assert.equal(resolveLineEnding(cmake, fs.readFileSync(cmake), { lineEnding: 'crlf' }, tmp), '\r\n');
  write('cmake/CMakeLists.txt');
  write('cmake/build/generated.vcxproj');
  write('cmake/build/CMakeCache.txt');
  const generated = write('cmake/build/generated.cpp', 'int x;\n');
  assert.equal(resolveLineEnding(generated, fs.readFileSync(generated), {}, tmp), '\n');
  const plain = write('plain/src/main.cpp');
  write('plain/build/other.sln');
  assert.equal(resolveLineEnding(plain, Buffer.from('int x;'), {}, tmp), '\n', '不扫描旁支 build 工程');
  assert.equal(resolveLineEnding(plain, Buffer.from('int x;\r\nint y;'), {}, tmp), '\r\n');

  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  for (const eol of ['\r\n', '\n']) {
    const body = Buffer.from('// 中文\r\nint x;\nint y;', 'utf8');
    const normalized = normalizeLineEndings(Buffer.concat([bom, body]), eol);
    assert.deepEqual(normalized, Buffer.concat([bom, Buffer.from(['// 中文', 'int x;', 'int y;', ''].join(eol))]));
    assert.deepEqual(normalizeLineEndings(normalized, eol), normalized);
    const gbk = Buffer.from([0x2f, 0x2f, 0xd6, 0xd0, 0xce, 0xc4]);
    assert.deepEqual(normalizeLineEndings(gbk, eol), Buffer.concat([gbk, Buffer.from(eol)]));
    for (const bigEndian of [false, true]) {
      const encode = (text) => {
        const bytes = Buffer.from(text, 'utf16le');
        if (bigEndian) bytes.swap16();
        return Buffer.concat([Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]), bytes]);
      };
      assert.deepEqual(normalizeLineEndings(encode('// 中文\nint x;'), eol), encode('// 中文' + eol + 'int x;' + eol));
    }
    assert.deepEqual(normalizeLineEndings(Buffer.alloc(0), eol), Buffer.alloc(0));
    assert.deepEqual(normalizeLineEndings(bom, eol), bom);
    const unknown = Buffer.from([0x69, 0, 0x6e, 0]);
    assert.deepEqual(normalizeLineEndings(unknown, eol), unknown);
    for (const utf32 of [Buffer.from([0xff, 0xfe, 0, 0, 0x61, 0, 0, 0]),
      Buffer.from([0, 0, 0xfe, 0xff, 0, 0, 0, 0x61])]) {
      assert.deepEqual(normalizeLineEndings(utf32, eol), utf32, '未知 UTF-32 不得误按 UTF-16 改写');
    }
  }
  console.log('line_endings.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
