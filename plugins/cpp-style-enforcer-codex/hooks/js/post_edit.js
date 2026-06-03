'use strict';

const { readStdinJson } = require('./lib/stdin');
const { passSilent, blockCodex, diag } = require('./lib/protocol');
const { resolveFilePath, shouldHandle } = require('./lib/target');
const { loadConfig } = require('./lib/config');
const { repoRoot, isNew } = require('./lib/git');
const { ensureClangFormatConfig } = require('./lib/ensure_clang_format_config');
const { ensureProjectConfig } = require('./lib/ensure_project_config');
const { isCMakeProject } = require('./lib/project');
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

  const filePath = resolveFilePath(input);
  if (!filePath || !shouldHandle(filePath)) return passSilent();

  const config = loadConfig(filePath);
  if (config.enabled === false) return passSilent();

  const { mode, checks, legacyChecks, copyrightInfo } = config;
  const root = step('repoRoot', () => repoRoot(filePath)) || null;
  const fileIsNew = step('isNew', () => isNew(filePath, root));
  const isNewFile = fileIsNew !== false;
  // mode=full 或新文件 → 用 checks（全套）；老文件 incremental → 用 legacyChecks
  const effectiveChecks = (mode === 'full' || isNewFile) ? checks : legacyChecks;
  const isCMake = step('isCMake', () => isCMakeProject(filePath)) === true;

  // 走全套时生成项目配置占位（新文件/full）；项目配置始终在首次触碰时生成
  if (mode === 'full' || isNewFile) {
    step('ensure_clang_format_config', () => ensureClangFormatConfig(root));
  }
  step('ensure_project_config', () => ensureProjectConfig(root));

  // 1. clang-format（新文件=整文件；老文件若 legacyChecks.clangFormat=true=改动行）
  if (effectiveChecks.clangFormat) {
    step('clang_format', () => applyClangFormat(filePath, { isNew: isNewFile, root }));
  }

  // 2. BOM（独立于 mode；CMake 项目跳过）
  if (effectiveChecks.bom && !isCMake) {
    step('bom', () => applyBom(filePath, { isCMake }));
  }

  // 3. copyright（company 非空才写；传 root 用于生成相对路径行）
  if (effectiveChecks.copyright && copyrightInfo && copyrightInfo.company) {
    step('copyright', () => applyCopyright(filePath, copyrightInfo, root));
  }

  // 4. cpplint → 有违规即 block
  if (effectiveChecks.cpplint) {
    const suppressCopyright = !(copyrightInfo && copyrightInfo.company) || checks.copyright === false;
    const violations = step('cpplint', () => runCpplint(filePath, { root, suppressCopyright })) || [];
    if (violations.length > 0) {
      return blockCodex(formatViolations(violations));
    }
  }

  return passSilent();
}

main().catch((e) => {
  try { diag(`post_edit 顶层异常兜底 passSilent: ${e && e.message ? e.message : e}`); } catch (_) {}
  passSilent();
});
