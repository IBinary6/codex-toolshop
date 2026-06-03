'use strict';

const fs = require('fs');
const { detectEncoding, BOM } = require('../lib/bom_util.js');
const { requireIconv } = require('../lib/ensure_deps.js');

/**
 * 补 UTF-8 BOM / GBK 转码加 BOM。内容无变化不写。
 * CMake 项目（isCMake=true）整体跳过。
 * @param {string} filePath
 * @param {{isCMake?:boolean}} options
 * @returns {boolean} 是否改写了文件
 */
function applyBom(filePath, options = {}) {
  if (options.isCMake) return false;
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (_) { return false; }

  // 空文件 → 只写 BOM
  if (buf.length === 0) {
    try { fs.writeFileSync(filePath, BOM); return true; } catch (_) { return false; }
  }

  const enc = detectEncoding(buf);
  // 不动：已有 BOM / UTF-16 / 无法确证编码（unknown）。
  // unknown 多为 GBK 但运行时缺 iconv-lite 而降级，若强补 UTF-8 BOM 会产出
  // EF BB BF + 原字节 的坏文件，破坏原本能正常打开的文件。
  if (enc === 'utf-8-bom' || enc === 'utf-16' || enc === 'unknown') return false;

  if (enc === 'gbk') {
    try {
      const iconv = requireIconv();            // 双保险解析 ROOT→DATA
      if (!iconv) return false;                // iconv 缺失 → 跳过，不崩
      const text = iconv.decode(buf, 'gbk');
      const out = Buffer.concat([BOM, Buffer.from(text, 'utf-8')]);
      fs.writeFileSync(filePath, out);
      return true;
    } catch (_) {
      return false; // iconv 缺失 → 跳过，不崩
    }
  }

  // 仅对确证的 utf-8（无 BOM）补 BOM
  try {
    fs.writeFileSync(filePath, Buffer.concat([BOM, buf]));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { applyBom };
