'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Check project markers only in ancestor directories, without recursively scanning sibling projects or build directories.
 * The nearest CMake source directory takes precedence over an upper solution; generated CMake directories are not native VS projects.
 */
function isVisualStudioSource(filePath, root = null) {
  let dir = path.dirname(path.resolve(filePath));
  let boundary = root ? path.resolve(root) : null;
  // Windows Git roots may use long paths while TEMP or callers use 8.3 paths; normalize both before boundary checks.
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

/** Map the text body to a string safe for line-ending changes while retaining original encoding and BOM bytes. */
function textView(raw) {
  // A UTF-32LE BOM starts with a UTF-16LE BOM; reject unsupported encoding before the UTF-16 branch.
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
  // Do not treat NUL content without known encoding as single-byte source, to avoid corrupting UTF-16 or binary files.
  if (raw.includes(0)) return null;
  const offset = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
  return {
    text: raw.subarray(offset).toString('latin1'),
    encode: (text) => Buffer.concat([raw.subarray(0, offset), Buffer.from(text, 'latin1')]),
  };
}

/** Without an explicit policy, preserve the majority line ending, choose the first on a tie, or LF if none exists. */
function existingLineEnding(raw) {
  const view = textView(raw);
  const endings = view ? view.text.match(/\r\n|\n|\r/g) || [] : [];
  const crlf = endings.filter((eol) => eol === '\r\n').length;
  const lf = endings.length - crlf;
  if (crlf === lf) return endings[0] === '\r\n' ? '\r\n' : '\n';
  return crlf > lf ? '\r\n' : '\n';
}

/** Enforce CRLF for VS source projects; otherwise use configuration or the body style read before editing. */
function resolveLineEnding(filePath, raw, config = {}, root = null) {
  if (isVisualStudioSource(filePath, root)) return '\r\n';
  if (config.lineEnding === 'crlf') return '\r\n';
  if (config.lineEnding === 'lf') return '\n';
  return existingLineEnding(raw);
}

/** Replace only line-ending bytes and add a final newline to a nonempty body; retain blank lines, encoding, and BOM. */
function normalizeLineEndings(raw, eol) {
  if (eol !== '\r\n' && eol !== '\n') throw new Error('Invalid line ending');
  const view = textView(raw);
  if (!view || !view.text) return raw;
  let text = view.text.replace(/\r\n|\n|\r/g, eol);
  if (!text.endsWith(eol)) text += eol;
  return view.encode(text);
}

/** Final line-ending repair independent of clang-format; avoid writing a compliant file. */
function applyLineEndings(filePath, eol) {
  const raw = fs.readFileSync(filePath);
  const normalized = normalizeLineEndings(raw, eol);
  if (normalized.equals(raw)) return false;
  fs.writeFileSync(filePath, normalized);
  return true;
}

module.exports = { isVisualStudioSource, existingLineEnding, resolveLineEnding, normalizeLineEndings, applyLineEndings };
