'use strict';

const fs = require('fs');
const path = require('path');
const { stripBom, restoreBom } = require('../lib/bom_util.js');

const DEFAULT_DATE_FORMAT = 'YYYY/MM/DD HH:mm';

const MARK_COPYRIGHT = '// Copyright';
const MARK_AUTHOR = '// Author';
const MARK_DATE = '// Date';

/** Filename-line allowlist: // followed by a relative path, with a slash or a C/C++ filename extension. */
const FILENAME_LINE = /^\/\/ \S+\.(?:c|cc|cpp|cxx|h|hpp|hxx)\s*$/i;

function validateDateFormat(fmt) {
  if (typeof fmt !== 'string') return DEFAULT_DATE_FORMAT;
  if (fmt.includes('YYYY') && fmt.includes('MM') && fmt.includes('DD')) return fmt;
  process.stderr.write('[cpp-style-enforcer] dateFormat lacks YYYY/MM/DD; using the default format\n');
  return DEFAULT_DATE_FORMAT;
}

function formatDate(fmt, d) {
  const tokens = {
    YYYY: String(d.getFullYear()),
    MM: String(d.getMonth() + 1).padStart(2, '0'),
    DD: String(d.getDate()).padStart(2, '0'),
    HH: String(d.getHours()).padStart(2, '0'),
    mm: String(d.getMinutes()).padStart(2, '0'),
  };
  return fmt.replace(/YYYY|MM|DD|HH|mm/g, (m) => tokens[m]);
}

function buildDateRegex(fmt) {
  let re = '';
  let i = 0;
  while (i < fmt.length) {
    if (fmt.startsWith('YYYY', i)) { re += '(?<Y>\\d{4})'; i += 4; }
    else if (fmt.startsWith('MM', i)) { re += '(?<M>\\d{2})'; i += 2; }
    else if (fmt.startsWith('DD', i)) { re += '(?<D>\\d{2})'; i += 2; }
    else if (fmt.startsWith('HH', i)) { re += '\\d{2}'; i += 2; }
    else if (fmt.startsWith('mm', i)) { re += '\\d{2}'; i += 2; }
    else { re += fmt[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 1; }
  }
  return new RegExp(MARK_DATE + ' ' + re);
}

/**
 * Parse the copyright block at file start, extracting semantic lines and body start.
 *
 * The header block is the first contiguous comment section at file start (allow leading spaces and initial blank lines).
 * Recognize four semantic lines: Copyright, Author, Date, and filename.
 *   - Take only the first of each kind, discarding duplicate semantic lines.
 *   - Blank lines between semantic lines are header separators; do not preserve them or stop scanning.
 *   - Preserve adjacent non-semantic comments in extraComments.
 *   - A comment after a blank line belongs to body documentation and ends the header block.
 * If the comment section has no semantic lines, treat the file as headerless and return all text to the body (bodyStart=0).
 *
 * @param {string[]} lines Text lines split with trailing CR removed
 * @returns {{copyright, author, date, relPathLine, bodyStart, extraComments:string[]}}
 */
function parseHeaderBlock(lines) {
  let copyright = null, author = null, date = null, relPathLine = null;
  const extraComments = [];
  let sawSemantic = false;
  let pendingBlank = 0;

  let i = 0;
  while (i < lines.length && lines[i].replace(/^\s+/, '') === '') i++; // Skip initial blank lines.

  for (; i < lines.length; i++) {
    const l = lines[i].replace(/^\s+/, ''); // Allow leading spaces.
    if (l === '') { pendingBlank++; continue; }
    if (!l.startsWith('//')) break; // A code line ends the header block.

    const isSemantic =
      l.startsWith(MARK_COPYRIGHT) || l.startsWith(MARK_AUTHOR) ||
      l.startsWith(MARK_DATE) || FILENAME_LINE.test(l);

    if (!isSemantic) {
      if (pendingBlank > 0) break; // A comment after a blank line is body documentation; end the header without consuming it.
      extraComments.push(lines[i]); // An adjacent non-semantic comment remains in the header unchanged.
      continue;
    }

    // Semantic line: drop pending header separator blanks and keep only the first of each kind.
    pendingBlank = 0;
    sawSemantic = true;
    if (l.startsWith(MARK_COPYRIGHT)) { if (!copyright) copyright = l; }
    else if (l.startsWith(MARK_AUTHOR)) { if (!author) author = l; }
    else if (l.startsWith(MARK_DATE)) { if (!date) date = l; }
    else if (!relPathLine) relPathLine = l;
  }

  if (!sawSemantic) {
    return { copyright: null, author: null, date: null, relPathLine: null, bodyStart: 0, extraComments: [] };
  }
  // i points to the header end (code, comment after blank line, or EOF); later lines are body.
  return { copyright, author, date, relPathLine, bodyStart: i, extraComments };
}

/**
 * Write copyright headers idempotently by field, minimizing Git changes:
 *   - Copyright, Author, and filepath lines: preserve existing text and add only missing lines.
 *   - Date: add if missing, skip if today, or update an older date.
 *   - Deduplicate semantic lines, keep interleaved comments, and write only if rebuilt text differs.
 *
 * @param {string} filePath
 * @param {{company:string, author:string, dateFormat:string}} copyrightInfo
 * @param {string|null} [root] Git repository root(Used to generate the repository-relative filepath line)
 * @returns {boolean} Whether the file was written
 */
function applyCopyright(filePath, copyrightInfo, root) {
  const { company, author } = copyrightInfo || {};
  if (!company) return false;

  let raw;
  try { raw = fs.readFileSync(filePath); } catch (_) { return false; }
  const { hadBom, body } = stripBom(raw);
  const origText = body.toString('utf-8');
  const eol = origText.includes('\r\n') ? '\r\n' : '\n'; // Preserve original line endings.
  const lines = origText.split(/\r?\n/); // Strip trailing CR for content comparison.

  const fmt = validateDateFormat(copyrightInfo.dateFormat);
  const now = new Date();
  const dateStr = formatDate(fmt, now);
  const relPath = root ? path.relative(root, filePath).replace(/\\/g, '/') : null;
  const relPathTarget = relPath ? `// ${relPath}` : null;

  const { copyright: existCopy, author: existAuthor, date: existDate,
    relPathLine: existRelPath, bodyStart, extraComments } = parseHeaderBlock(lines);

  // Check whether Date is today.
  let dateIsToday = false;
  if (existDate) {
    const m = existDate.match(buildDateRegex(fmt));
    dateIsToday = !!(m && m.groups &&
      m.groups.Y === String(now.getFullYear()) &&
      m.groups.M === String(now.getMonth() + 1).padStart(2, '0') &&
      m.groups.D === String(now.getDate()).padStart(2, '0'));
  }

  // Compute final fields: preserve existing, add missing, update Date when not today.
  const copyLine = existCopy || `${MARK_COPYRIGHT} ${now.getFullYear()} ${company}`;
  const authorLine = existAuthor || (author ? `${MARK_AUTHOR} ${author}` : null);
  const dateLine = (existDate && dateIsToday) ? existDate : `${MARK_DATE} ${dateStr}`;
  const relLine = relPathTarget || (root ? existRelPath : null);

  const newHdrLines = [
    copyLine,
    ...(authorLine ? [authorLine] : []),
    dateLine,
    ...(relLine ? [relLine] : []),
  ];

  // Keep interleaved extraComments after the header and before the body.
  const bodyLines = lines.slice(bodyStart);
  const newLines = [...newHdrLines, ...extraComments, '', ...bodyLines];

  // Compare rebuilt text with original: compliant text is untouched; duplicates or interleaved comments cause cleanup.
  // Restore original line endings without converting CRLF files to LF.
  const newText = newLines.join(eol);
  if (newText === origText) return false;

  try {
    fs.writeFileSync(filePath, restoreBom(hadBom, Buffer.from(newText, 'utf-8')));
    return true;
  } catch (_) {
    process.stderr.write('[cpp-style-enforcer] Could not write copyright header; skipping: ' + filePath + '\n');
    return false;
  }
}

module.exports = { applyCopyright, formatDate, validateDateFormat, buildDateRegex, parseHeaderBlock };
