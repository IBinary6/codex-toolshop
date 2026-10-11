'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const { stripBom, restoreBom } = require('../lib/bom_util.js');
const { changedLineRanges } = require('../lib/git.js');
const { detectClangFormat } = require('../lib/ensure_deps.js');
const { isVisualStudioSource } = require('../lib/line_endings.js');

const isWindows = process.platform === 'win32';

/**
 * Restore formatted line endings to the source style.
 *
 * Some clang-format versions or BasedOnStyle presets emit LF for CRLF input (DeriveLineEnding
 * behavior varies). VS sources often use CRLF; silent LF conversion would diff every line.
 * Restore the input ending directly, independent of clang-format configuration, across versions and existing projects.
 *
 * Implementation: normalize output to LF using byte-safe latin1, then restore CRLF if the source uses it.
 * latin1 round-tripping preserves UTF-8 multibyte data; replacement touches only CR (0x0D) and LF (0x0A).
 *
 * @param {Buffer} formatted clang-format output bytes
 * @param {Buffer} source Input body after BOM removal (line-ending reference)
 * @returns {Buffer} Output with source line endings
 */
function matchLineEnding(formatted, source) {
  const sourceCRLF = source.includes('\r\n');
  let s = formatted.toString('latin1').replace(/\r\n/g, '\n'); // Normalize to LF.
  if (sourceCRLF) s = s.replace(/\n/g, '\r\n');                // Restore CRLF.
  return Buffer.from(s, 'latin1');
}

/**
 * BOM-aware clang-format with two modes.
 * Strip BOM -> feed the body without BOM to clang-format via stdin -> compare with that body.
 * -> restoreBom and write only on change. Return false silently if clang-format is missing or fails; do not use -i.
 *
 * Mode is set by opts.isNew (defaults to a new file):
 * - New files: format the whole file with -style=file -fallback-style=Google; VS source projects preserve include
 *   order; other projects use project sort settings. Existing clang-format off/on regions remain protected.
 * - Tracked files: format only changed Git lines (--lines=s:e), using project style and overriding include sorting;
 *   return false without formatting if no lines changed.
 *
 * Line numbers: --lines applies to stdin body without a BOM. Removing a BOM only removes the leading
 * three bytes at the first line start, without changing line count, so Git diff line numbers apply directly.
 *
 * @param {string} filePath
 * @param {{isNew?:boolean, root?:string|null, detect?:function():({cmd:string,args:string[]}|null)}} [opts]
 * @returns {boolean} Whether the file was rewritten
 */
function applyClangFormat(filePath, opts) {
  const isNew = !opts || opts.isNew !== false; // Default: whole-file mode for new files.
  const root = opts && opts.root ? opts.root : null;
  // Detect only: edit hooks do not install with pip, avoiding blocks or timeouts.
  const detect = (opts && opts.detect) || detectClangFormat;
  let desc = null;
  try { desc = detect(); } catch (_) { desc = null; }
  if (!desc) return false; // clang-format unavailable: skip silently.

  let raw;
  try { raw = fs.readFileSync(filePath); } catch (_) { return false; }
  const { hadBom, body } = stripBom(raw);

  let args;
  if (isNew) {
    args = ['-style=file', '-fallback-style=Google', `-assume-filename=${filePath}`];
    // VS headers may depend on earlier types or macros; do not reorder includes merely because a file is uncommitted.
    if (isVisualStudioSource(filePath, root)) args.push('--sort-includes=false');
  } else {
    const ranges = changedLineRanges(filePath, root);
    if (!ranges || ranges.length === 0) return false; // No changed lines: skip formatting.
    args = ['-style=file', '-fallback-style=Google', '--sort-includes=false', `-assume-filename=${filePath}`];
    for (const [s, e] of ranges) args.push(`--lines=${s}:${e}`);
  }

  const r = spawnSync(
    desc.cmd,
    [...desc.args, ...args],
    { input: body, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 32 * 1024 * 1024, windowsHide: isWindows }
  );
  // clang-format failure: skip silently.
  if (r.error || r.status !== 0 || !r.stdout) return false;

  const rawFormatted = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout);
  // Restore input line endings so clang-format does not turn CRLF into an entire-file diff.
  const formatted = matchLineEnding(rawFormatted, body);
  if (formatted.equals(body)) return false; // No change after restoring endings: do not write.

  try {
    fs.writeFileSync(filePath, restoreBom(hadBom, formatted));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { applyClangFormat, matchLineEnding };
