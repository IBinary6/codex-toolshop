'use strict';

const { requireIconv } = require('./ensure_deps.js');

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);          // UTF-8 BOM
const UTF16LE_BOM = Buffer.from([0xFF, 0xFE]);         // UTF-16 LE BOM
const UTF16BE_BOM = Buffer.from([0xFE, 0xFF]);         // UTF-16 BE BOM

/**
 * 剥除所有前导 UTF-8 BOM。
 * @param {Buffer} buf 原始字节
 * @returns {{hadBom:boolean, body:Buffer}} hadBom=是否有前导BOM；body=无BOM正文
 */
function stripBom(buf) {
  let offset = 0;
  while (offset + BOM.length <= buf.length &&
         buf[offset] === BOM[0] && buf[offset + 1] === BOM[1] && buf[offset + 2] === BOM[2]) {
    offset += BOM.length;
  }
  // Buffer.from(subarray) 复制出独立内存，避免与原 buf 共享底层（含 offset=0 分支）
  return { hadBom: offset > 0, body: Buffer.from(buf.subarray(offset)) };
}

/**
 * 按 hadBom 拼回恰好一个 BOM（多 BOM 已在 stripBom 归一）。
 * @param {boolean} hadBom
 * @param {Buffer} body 无 BOM 正文
 * @returns {Buffer}
 */
function restoreBom(hadBom, body) {
  return hadBom ? Buffer.concat([BOM, body]) : body;
}

/**
 * 检测编码。返回 'utf-8-bom' | 'utf-16' | 'utf-8' | 'gbk' | 'unknown'。
 * @param {Buffer} buf
 * @returns {string}
 */
function detectEncoding(buf) {
  if (buf.length >= BOM.length && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2]) return 'utf-8-bom';
  if (buf.length >= 2 &&
      ((buf[0] === UTF16LE_BOM[0] && buf[1] === UTF16LE_BOM[1]) ||
       (buf[0] === UTF16BE_BOM[0] && buf[1] === UTF16BE_BOM[1]))) return 'utf-16';
  if (isValidUtf8(buf)) return 'utf-8';
  try {
    const iconv = requireIconv();              // 双保险解析 ROOT→DATA，缺失返回 null
    // gbk 为兜底分类：iconv 对多数字节都能解码，不保证精确
    if (iconv && iconv.decode(buf, 'gbk').length > 0) return 'gbk';
  } catch (_) {}
  return 'unknown';
}

/** 严格 UTF-8 校验（含高位字节也能正确区分 UTF-8 与 GBK） */
function isValidUtf8(buf) {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b <= 0x7F) { i += 1; continue; }
    let n;
    if ((b & 0xE0) === 0xC0) n = 1;        // 110xxxxx → 2 字节序列
    else if ((b & 0xF0) === 0xE0) n = 2;   // 1110xxxx → 3 字节序列
    else if ((b & 0xF8) === 0xF0) n = 3;   // 11110xxx → 4 字节序列
    else return false;
    if (i + n >= buf.length) return false;
    for (let j = 1; j <= n; j++) {
      if ((buf[i + j] & 0xC0) !== 0x80) return false;   // 续字节须为 10xxxxxx
    }
    i += n + 1;
  }
  return true;
}

module.exports = { stripBom, restoreBom, detectEncoding, BOM };
