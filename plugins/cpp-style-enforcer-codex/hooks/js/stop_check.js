'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readStdinJson } = require('./lib/stdin');
const { diag } = require('./lib/protocol');
const { shouldHandle } = require('./lib/target');
const { consumePendingPaths } = require('./lib/pending_edits');
const { loadConfig } = require('./lib/config');
const { repoRoot, isNew } = require('./lib/git');
const { formatChangedFiles } = require('./lib/report');
const { ensureClangFormatConfig } = require('./lib/ensure_clang_format_config');
const { ensureProjectConfig } = require('./lib/ensure_project_config');
const { applyClangFormat } = require('./steps/clang_format');
const { applyBom } = require('./steps/bom');
const { applyCopyright } = require('./steps/copyright');
const { runCpplint, formatViolations } = require('./steps/cpplint');
const { resolveLineEnding, applyLineEndings, isVisualStudioSource } = require('./lib/line_endings');

function step(name, fn) {
  try {
    return fn();
  } catch (error) {
    diag(`step ${name} failed and was skipped: ${error && error.message ? error.message : error}`);
    return undefined;
  }
}

function finish(payload = {}) {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

function displayPath(filePath, root) {
  return root ? path.relative(root, filePath) : filePath;
}

/** Choose a root for cpplint so non-Git header guards do not include machine-specific absolute paths. */
function lintRootForFile(filePath, root, cwd) {
  if (root) return root;

  const candidates = [cwd];
  try { candidates.push(process.cwd()); } catch (_) {}
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
      const relative = path.relative(candidate, filePath);
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return path.resolve(candidate);
      }
    } catch (_) {}
  }
  return path.dirname(filePath);
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 5000 });
  if (!input) return finish();

  const filePaths = consumePendingPaths(input)
    .filter(shouldHandle)
    .filter((filePath) => {
      try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
    });
  if (filePaths.length === 0) return finish();

  const changedFiles = [];
  const allViolations = [];
  for (const filePath of filePaths) {
    const config = loadConfig(filePath);
    if (config.enabled === false) continue;

    const { mode, checks, legacyChecks, copyrightInfo } = config;
    const root = step('repoRoot', () => repoRoot(filePath)) || null;
    const fileIsNew = step('isNew', () => isNew(filePath, root));
    const isNewFile = fileIsNew !== false;
    const effectiveChecks = (mode === 'full' || isNewFile) ? checks : legacyChecks;
    const hasChecks = Object.values(effectiveChecks).some(Boolean);
    // Fix the desired ending before formatting/copyright can add newlines; VS projects do not follow accidentally introduced LF.
    const eol = resolveLineEnding(filePath, fs.readFileSync(filePath), config, root);

    if (effectiveChecks.clangFormat && (mode === 'full' || isNewFile)) {
      step('ensure_clang_format_config', () => ensureClangFormatConfig(root));
    }
    if (hasChecks) step('ensure_project_config', () => ensureProjectConfig(root));

    let changed = false;
    if (effectiveChecks.clangFormat) {
      changed = step('clang_format', () => applyClangFormat(filePath, { isNew: isNewFile, root })) === true || changed;
    }
    // Tracked files retain their encoding; BOM normalization applies only to new files without a historical encoding contract.
    if (isNewFile && effectiveChecks.bom) {
      changed = step('bom', () => applyBom(filePath)) === true || changed;
    }
    if (effectiveChecks.copyright && copyrightInfo && copyrightInfo.company) {
      changed = step('copyright', () => applyCopyright(filePath, copyrightInfo, root)) === true || changed;
    }
    // Basic line-ending repair is independent of style switches and clang-format availability; it does not modify the Git index.
    try {
      changed = applyLineEndings(filePath, eol) || changed;
    } catch (error) {
      allViolations.push({ file: displayPath(filePath, root), line: 0,
        category: 'runtime/line_endings', message: `Line-ending repair incomplete: ${error.message || error}` });
    }
    if (changed) changedFiles.push(displayPath(filePath, root));

    if (effectiveChecks.cpplint) {
      const lintRoot = lintRootForFile(filePath, root, input.cwd);
      const suppressCopyright = !(copyrightInfo && copyrightInfo.company) || checks.copyright === false;
      const violations = step('cpplint', () => runCpplint(filePath, {
        root: lintRoot, suppressCopyright, preserveIncludeOrder: isVisualStudioSource(filePath, root),
      })) || [];
      for (const violation of violations) {
        allViolations.push({ ...violation, file: displayPath(filePath, root) });
      }
    }
  }

  if (changedFiles.length === 0 && allViolations.length === 0) return finish();

  const reasons = [];
  if (changedFiles.length > 0) {
    reasons.push(`C++ Style normalized ${changedFiles.length} files:\n` +
      formatChangedFiles(changedFiles));
  }
  if (allViolations.length > 0) reasons.push(formatViolations(allViolations));
  reasons.push('Review the final diff, fix remaining violations, and rerun relevant verification. Keep CRLF in Visual Studio source projects; other projects follow lineEnding. Add a missing final newline in the chosen style instead of converting everything to LF.');
  const reason = reasons.join('\n\n');

  if (input.stop_hook_active) {
    return finish({ systemMessage: reason });
  }
  return finish({ decision: 'block', reason });
}

main().catch((error) => {
  try { diag(`stop_check top-level error: ${error && error.message ? error.message : error}`); } catch (_) {}
  finish({ systemMessage: 'C++ Style final check failed; run the pre-commit check manually.' });
});
