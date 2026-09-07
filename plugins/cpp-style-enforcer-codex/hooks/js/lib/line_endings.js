'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 只检查文件祖先目录的项目标志，不递归扫描同仓库其他项目或 build 目录。
 * 最近的 CMake 源目录优先于上层解决方案；CMake 生成目录不作为原生 VS 工程。
 */
function isVisualStudioSource(filePath, root = null) {
  let dir = path.dirname(path.resolve(filePath));
  let boundary = root ? path.resolve(root) : null;
  // Windows Git 根可能是长路径，TEMP/调用方可能使用 8.3 路径；统一后再比较边界。
  try { dir = fs.realpathSync(dir); } catch (_) {}
  if (boundary) { try { boundary = fs.realpathSync(boundary); } catch (_) {} }
  while (true) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) {}
    const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase());
    if (names.includes('cmakelists.txt')) return false;
    const generated = names.includes('cmakecache.txt')
      || entries.some((entry) => entry.isDirectory() && entry.name === 'CMakeFiles');
    if (!generated && names.some((name) => /\.(?:vcxproj|vcproj|sln|slnx)$/.test(name))) return true;
    const parent = path.dirname(dir);
    if (dir === boundary || parent === dir) return false;
    dir = parent;
  }
}

/** 将文本正文映射为可安全处理换行的字符串，同时保留编码与 BOM 原始字节。 */
function textView(raw) {
  // UTF-32LE 的 BOM 以 UTF-16LE BOM 开头；未支持的编码必须在 UTF-16 分支前排除。
  if (raw.length >= 4 && (raw.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0]))
      || raw.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff])))) return null;
  if (raw.length >= 2 && ((raw[0] === 0xff && raw[1] === 0xfe)
      || (raw[0] === 0xfe && raw[1] === 0xff))) {
    if (raw.length % 2 !== 0) return null;
    const bigEndian = raw[0] === 0xfe;
    const body = Buffer.from(raw.subarray(2));
    if (bigEndian) body.swap16();
    return {
      text: body.toString('utf16le'),
      encode(text) {
        const bytes = Buffer.from(text, 'utf16le');
        if (bigEndian) bytes.swap16();
        return Buffer.concat([raw.subarray(0, 2), bytes]);
      },
    };
  }
  // 未标明编码的 NUL 内容不按单字节源码处理，避免破坏 UTF-16/二进制文件。
  if (raw.includes(0)) return null;
  const offset = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
  return {
    text: raw.subarray(offset).toString('latin1'),
    encode: (text) => Buffer.concat([raw.subarray(0, offset), Buffer.from(text, 'latin1')]),
  };
}

/** 无明确策略时保留占多数的行尾；数量相同时采用首个行尾，无行尾时采用 LF。 */
function existingLineEnding(raw) {
  const view = textView(raw);
  const endings = view ? view.text.match(/\r\n|\n|\r/g) || [] : [];
  const crlf = endings.filter((eol) => eol === '\r\n').length;
  const lf = endings.length - crlf;
  if (crlf === lf) return endings[0] === '\r\n' ? '\r\n' : '\n';
  return crlf > lf ? '\r\n' : '\n';
}

/** VS 源工程强制 CRLF；其他工程按配置或编辑前读取的当前正文风格决定。 */
function resolveLineEnding(filePath, raw, config = {}, root = null) {
  if (isVisualStudioSource(filePath, root)) return '\r\n';
  if (config.lineEnding === 'crlf') return '\r\n';
  if (config.lineEnding === 'lf') return '\n';
  return existingLineEnding(raw);
}

/** 仅替换换行字节并补齐非空正文的末尾换行，不移除已有空行、不转码或调整 BOM。 */
function normalizeLineEndings(raw, eol) {
  if (eol !== '\r\n' && eol !== '\n') throw new Error('Invalid line ending');
  const view = textView(raw);
  if (!view || !view.text) return raw;
  let text = view.text.replace(/\r\n|\n|\r/g, eol);
  if (!text.endsWith(eol)) text += eol;
  return view.encode(text);
}

/** 独立于 clang-format 的最终行尾修复；已符合要求时不写盘。 */
function applyLineEndings(filePath, eol) {
  const raw = fs.readFileSync(filePath);
  const normalized = normalizeLineEndings(raw, eol);
  if (normalized.equals(raw)) return false;
  fs.writeFileSync(filePath, normalized);
  return true;
}

module.exports = { isVisualStudioSource, existingLineEnding, resolveLineEnding, normalizeLineEndings, applyLineEndings };
