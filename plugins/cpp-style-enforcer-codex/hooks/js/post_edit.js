'use strict';

const { readStdinJson } = require('./lib/stdin');
const { passSilent, blockCodex, diag } = require('./lib/protocol');
const { resolveFilePaths, shouldHandle } = require('./lib/target');
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
  } catch (e) {
    diag(`step ${name} 异常跳过: ${e && e.message ? e.message : e}`);
    return undefined;
  }
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 5000 });
  if (!input) return passSilent();

  const filePaths = resolveFilePaths(input).filter(shouldHandle);
  if (filePaths.length === 0) return passSilent();

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

    if (effectiveChecks.clangFormat) {
      step('clang_format', () => applyClangFormat(filePath, { isNew: isNewFile, root }));
    }
    if (effectiveChecks.bom) {
      step('bom', () => applyBom(filePath));
    }
    if (effectiveChecks.copyright && copyrightInfo && copyrightInfo.company) {
      step('copyright', () => applyCopyright(filePath, copyrightInfo, root));
    }
    if (effectiveChecks.cpplint) {
      const suppressCopyright = !(copyrightInfo && copyrightInfo.company) || checks.copyright === false;
      const violations = step('cpplint', () => runCpplint(filePath, { root, suppressCopyright })) || [];
      allViolations.push(...violations);
    }
  }

  if (allViolations.length > 0) {
    return blockCodex(formatViolations(allViolations));
  }

  return passSilent();
}

main().catch((e) => {
  try { diag(`post_edit 顶层异常兜底 passSilent: ${e && e.message ? e.message : e}`); } catch (_) {}
  passSilent();
});
