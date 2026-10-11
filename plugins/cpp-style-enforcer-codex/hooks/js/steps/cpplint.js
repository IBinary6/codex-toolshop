'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolvePython } = require('../lib/python');
const { isExcludedPath } = require('../lib/target');

const isWindows = process.platform === 'win32';
const MAX_ERRORS_SHOWN = 5;
const CPPLINT_PY = path.join(__dirname, '..', 'cpplint', 'cpplint.py');

/** Parse cpplint stderr:`path:line:  message  [category] [conf]` → {line,category,message} */
function parseCpplintOutput(out) {
  const violations = [];
  const re = /^.*?:(\d+):\s+(.*?)\s+\[([^\]]+)\](?:\s+\[\d+\])?\s*$/;
  for (const raw of String(out).split(/\r?\n/)) {
    const m = raw.match(re);
    if (!m) continue;
    violations.push({ line: parseInt(m[1], 10), message: m[2].trim(), category: m[3].trim() });
  }
  return violations;
}

/**
 * cpplint checks always disabled to match the global cpplint version.
 * - whitespace/indent_namespace: Google Style does not indent namespace contents,
 *   but clang-format formats only changed lines and legacy code may still be indented;
 *   suppress this check to avoid cascading 80-character violations from added NOLINT comments.
 */
const DEFAULT_FILTERS = ['-whitespace/indent_namespace'];

/**
 * Merge filters: default exclusions, optional -legal/copyright, and caller additions;
 * deduplicate into one comma-separated --filter value
 * (cpplint accepts one --filter). Return null when empty so the caller omits it.
 * @param {{suppressCopyright?:boolean, preserveIncludeOrder?:boolean, extraFilters?:string[]}} options
 * @returns {string|null}
 */
function buildFilterArg(options = {}) {
  const filters = [...DEFAULT_FILTERS];
  if (options.suppressCopyright) filters.push('-legal/copyright');
  if (options.preserveIncludeOrder) filters.push('-build/include_order');
  if (Array.isArray(options.extraFilters)) filters.push(...options.extraFilters);
  const uniq = [];
  const seen = new Set();
  for (const f of filters) {
    if (!f || seen.has(f)) continue;
    seen.add(f);
    uniq.push(f);
  }
  if (uniq.length === 0) return null;
  return '--filter=' + uniq.join(',');
}

/**
 * Run cpplint on the original real path without a temporary copy.
 *
 * A temporary copy would change the filename/path used by cpplint to compute header_guard macros and the basename
 * used to identify a matching main header for include_order. A hashed temporary path would cause false
 * build/header_guard and build/include_order diagnostics. The real path preserves both.
 *
 * The bundled cpplint reads with utf-8-sig and ignores BOM; this step never writes files,
 * Even interruption preserves BOM, mtime, LF/CRLF, and original bytes.
 *
 * VS callers pass preserveIncludeOrder to avoid conflicting with formatter preservation of dependency-sensitive headers;
 * other projects use configured cpplint order, and other checks are unaffected.
 * @param {string} filePath
 * @param {{root?:string, suppressCopyright?:boolean, preserveIncludeOrder?:boolean, extraFilters?:string[], timeoutMs?:number}} options
 * @returns {Array<{line:number, category:string, message:string}>}
 */
function runCpplint(filePath, options = {}) {
  // The hook entry filters paths; this wrapper also avoids linting third-party and build-output directories when called directly.
  if (isExcludedPath(filePath)) return [];
  const failure = (message, category = 'runtime/cpplint') => [{ line: 0, category, message }];
  let python;
  try { python = (options.resolvePython || resolvePython)(); } catch (error) {
    return failure(`Could not detect Python:${error.message || error}`);
  }
  if (!python || !fs.existsSync(CPPLINT_PY)) {
    return failure('Python/cpplint unavailable; check not run');
  }

  try { fs.accessSync(filePath, fs.constants.R_OK); } catch (_) {
    return failure('Could not read the target file; check not run');
  }

  const args = [CPPLINT_PY, '--quiet'];
  if (options.root) args.push('--root=' + options.root);
  const filterArg = buildFilterArg(options);
  if (filterArg) args.push(filterArg);
  args.push(filePath);

  try {
    const r = (options.spawnSync || spawnSync)(python.cmd, [...python.args, ...args], {
      stdio: 'pipe',
      timeout: Math.max(1000, options.timeoutMs || 15000),
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: isWindows,
    });
    if (r.error && r.error.code === 'ETIMEDOUT') {
      return failure('cpplint timed out; check incomplete', 'runtime/timeout');
    }
    if (r.error) return failure(`Could not run cpplint:${r.error.code || r.error.message}`);
    const stderr = (r.stderr || Buffer.alloc(0)).toString('utf-8');
    const violations = parseCpplintOutput(stderr);
    if (r.status !== 0 && violations.length === 0) {
      return failure(`cpplint exited abnormally (exit code ${r.status}); check incomplete`);
    }
    if (/Skipping input|Can't open for reading|Error reading config|Invalid configuration|Line length must be numeric/i.test(stderr)) {
      return [...violations, ...failure('cpplint could not read source or configuration; check incomplete')];
    }
    return violations;
  } catch (error) {
    return failure(`cpplint check error:${error.message || error}`);
  }
}

/**
 * Deduplicate by exact file:line:category:message, show the first five, and build a reason with remaining count.
 * All are hard violations requiring repair.
 * @param {Array<{file?:string, line:number, category:string, message:string}>} violations
 * @returns {string}
 */
function formatViolations(violations) {
  const seen = new Set();
  const unique = [];
  for (const v of violations) {
    const key = `${v.file || ''}:${v.line}:${v.category}:${v.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(v);
  }
  const shown = unique.slice(0, MAX_ERRORS_SHOWN);
  const lines = shown.map((v) => {
    const where = v.file ? `${v.file}:${v.line}` : `line ${v.line}`;
    return `  - ${where} [${v.category}] ${v.message}`;
  });
  let reason = 'cpplint found these C++ style violations; please fix them:\n' + lines.join('\n');
  if (unique.some((v) => v.category === 'whitespace/ending_newline'
      || (v.category === 'whitespace/newline' && /Mixed LF and CRLF/.test(v.message)))) {
    reason += '\nFix line endings according to project rules: Visual Studio source projects use CRLF; others follow lineEnding or their existing style. Add only the same style of final newline. Commit checks read staged content; after repairing the worktree, update only the intended staged scope without overwriting unstaged edits.';
  }
  const remaining = unique.length - shown.length;
  if (remaining > 0) {
    reason += `\n  ... ${remaining} more violations not shown; edit this file again after fixing the above to recheck`;
  }
  return reason;
}

module.exports = {
  runCpplint,
  formatViolations,
  parseCpplintOutput,
  buildFilterArg,
  MAX_ERRORS_SHOWN,
};
