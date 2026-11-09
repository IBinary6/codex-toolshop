'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { repoRoot, isNew } = require('./git');
const { ensureClangFormatConfig } = require('./ensure_clang_format_config');
const { ensureProjectConfig } = require('./ensure_project_config');
const { resolveLineEnding, applyLineEndings, isVisualStudioSource } = require('./line_endings');
const { applyClangFormat } = require('../steps/clang_format');
const { applyBom } = require('../steps/bom');
const { applyCopyright } = require('../steps/copyright');
const { runCpplint } = require('../steps/cpplint');

/** Keep non-Git header guards independent of absolute machine paths. */
function lintRootForFile(filePath, root, cwd) {
  if (root) return root;
  for (const candidate of [cwd, process.cwd()]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
      const relative = path.relative(candidate, filePath);
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return candidate;
    } catch (_) {}
  }
  return path.dirname(filePath);
}

/** Process edited worktree files before the next model action. Never write the Git index. */
function checkEditedFiles(filePaths, { cwd, deadline }) {
  const violations = [];
  for (const filePath of filePaths) {
    if (Date.now() >= deadline) {
      violations.push({ file: filePath, line: 0, category: 'runtime/timeout',
        message: 'C++ style check exceeded its time budget; this and remaining files were not checked' });
      break;
    }
    let root;
    let operation = 'read_source';
    const step = (name, run) => {
      operation = name;
      if (Date.now() >= deadline) throw new Error('C++ style check exceeded its time budget');
      return run();
    };
    try {
      let stat;
      try { stat = fs.statSync(filePath); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile()) continue;
      const config = step('config', () => loadConfig(filePath));
      if (!config.enabled) continue;
      const { mode, checks, legacyChecks, copyrightInfo } = config;
      root = step('git', () => repoRoot(filePath, { strict: true, deadline }));
      const isNewFile = step('git', () => isNew(filePath, root, { strict: true, deadline }));
      const effectiveChecks = mode === 'full' || isNewFile ? checks : legacyChecks;
      // Establish the original ending before any other step adds line breaks.
      const eol = step('line_endings', () => resolveLineEnding(filePath, fs.readFileSync(filePath), config, root));
      if (effectiveChecks.clangFormat && (mode === 'full' || isNewFile)) {
        step('clang_format_config', () => ensureClangFormatConfig(root, { strict: true }));
      }
      if (Object.values(effectiveChecks).some(Boolean)) {
        step('project_config', () => ensureProjectConfig(root, undefined, { strict: true }));
      }
      const check = (name, run) => {
        try { return step(name, run); }
        catch (error) {
          violations.push({ file: root ? path.relative(root, filePath) : filePath, line: 0,
            category: `runtime/${name}`, message: `Verification incomplete. ${error.message}` });
          return undefined;
        }
      };
      const opts = { isNew: isNewFile, root, deadline, strict: true };
      if (effectiveChecks.clangFormat) check('clang_format', () => applyClangFormat(filePath, opts));
      if (isNewFile && effectiveChecks.bom) check('bom', () => applyBom(filePath, opts));
      if (effectiveChecks.copyright && copyrightInfo.company) {
        check('copyright', () => applyCopyright(filePath, copyrightInfo, root, opts));
      }
      check('line_endings', () => applyLineEndings(filePath, eol));
      if (effectiveChecks.cpplint) {
        const items = check('cpplint', () => runCpplint(filePath, {
          root: lintRootForFile(filePath, root, cwd),
          suppressCopyright: !copyrightInfo.company || checks.copyright === false,
          preserveIncludeOrder: isVisualStudioSource(filePath, root),
          deadline,
        })) || [];
        for (const item of items) violations.push({ ...item, file: root ? path.relative(root, filePath) : filePath });
      }
    } catch (error) {
      violations.push({ file: root ? path.relative(root, filePath) : filePath, line: 0,
        category: `runtime/${operation}`, message: `Verification incomplete. ${error.message}` });
    }
  }
  return violations;
}

module.exports = { checkEditedFiles };
