'use strict';

const fs = require('fs');
const { detectEncoding, BOM } = require('../lib/bom_util.js');
const { requireIconv } = require('../lib/ensure_deps.js');

/**
 * Add a UTF-8 BOM, transcoding GBK when needed; do not write unchanged content.
 * @param {string} filePath
 * @param {{isCMake?:boolean}} options Retained for legacy callers; CMake no longer skips BOM
 * @returns {boolean} Whether the file was rewritten
 */
function applyBom(filePath, options = {}) {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (_) { return false; }

  // Empty file: write only a BOM.
  if (buf.length === 0) {
    try { fs.writeFileSync(filePath, BOM); return true; } catch (_) { return false; }
  }

  const enc = detectEncoding(buf);
  // Leave existing BOM, UTF-16, and unconfirmed encoding (unknown) untouched.
  // unknown often means GBK with iconv-lite unavailable; forcing a UTF-8 BOM would produce
  // a damaged EF BB BF + original-bytes file that previously opened correctly.
  if (enc === 'utf-8-bom' || enc === 'utf-16' || enc === 'unknown') return false;

  if (enc === 'gbk') {
    try {
      const iconv = requireIconv();            // Resolve from ROOT then DATA.
      if (!iconv) return false;                // Missing iconv: skip without crashing.
      const text = iconv.decode(buf, 'gbk');
      const out = Buffer.concat([BOM, Buffer.from(text, 'utf-8')]);
      fs.writeFileSync(filePath, out);
      return true;
    } catch (_) {
      return false; // Missing iconv: skip without crashing.
    }
  }

  // Add a BOM only to confirmed UTF-8 without one.
  try {
    fs.writeFileSync(filePath, Buffer.concat([BOM, buf]));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { applyBom };
