'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readStdinJson } = require('./lib/stdin');
const { diag } = require('./lib/protocol');
const { shouldHandle } = require('./lib/target');
const { consumePendingPaths } = require('./lib/pending_edits');
const { loadConfig } = require('./lib/config');
const { repoRoot, isNew } = require('./lib/git');
const { ensureClangFormatConfig } = require('./lib/ensure_clang_format_config');
const { ensureProjectConfig } = require('./lib/ensure_project_config');
const { applyClangFormat } = require('./steps/clang_format');
const { applyBom } = require('./steps/bom');
const { applyCopyright } = require('./steps/copyright');
const { runCpplint, formatViolations } = require('./steps/cpplint');

function step(name, fn) {
  try {
    return fn();
  } catch (error) {
    diag(`step ${name} 异常跳过: ${error && error.message ? error.message : error}`);
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

    if (mode === 'full' || isNewFile) {
      step('ensure_clang_format_config', () => ensureClangFormatConfig(root));
    }
    step('ensure_project_config', () => ensureProjectConfig(root));

    let changed = false;
    if (effectiveChecks.clangFormat) {
      changed = step('clang_format', () => applyClangFormat(filePath, { isNew: isNewFile, root })) === true || changed;
    }
    if (effectiveChecks.bom) {
      changed = step('bom', () => applyBom(filePath)) === true || changed;
    }
    if (effectiveChecks.copyright && copyrightInfo && copyrightInfo.company) {
      changed = step('copyright', () => applyCopyright(filePath, copyrightInfo, root)) === true || changed;
    }
    if (changed) changedFiles.push(displayPath(filePath, root));

    if (effectiveChecks.cpplint) {
      const suppressCopyright = !(copyrightInfo && copyrightInfo.company) || checks.copyright === false;
      const violations = step('cpplint', () => runCpplint(filePath, { root, suppressCopyright })) || [];
      for (const violation of violations) {
        allViolations.push({ ...violation, file: displayPath(filePath, root) });
      }
    }
  }

  if (changedFiles.length === 0 && allViolations.length === 0) return finish();

  const reasons = [];
  if (changedFiles.length > 0) {
    reasons.push(`C++ Style 已在本轮编辑结束后统一规范化 ${changedFiles.length} 个文件：\n` +
      changedFiles.map((filePath) => `  - ${filePath}`).join('\n'));
  }
  if (allViolations.length > 0) reasons.push(formatViolations(allViolations));
  reasons.push('请检查最终 diff，修复剩余违规，并重新运行相关验证；不要跳过闭环检查。');
  const reason = reasons.join('\n\n');

  if (input.stop_hook_active) {
    return finish({ systemMessage: reason });
  }
  return finish({ decision: 'block', reason });
}

main().catch((error) => {
  try { diag(`stop_check 顶层异常: ${error && error.message ? error.message : error}`); } catch (_) {}
  finish({ systemMessage: 'C++ Style 收尾检查异常，请手动运行提交前检查。' });
});
