'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stripBom, restoreBom } = require('../lib/bom_util.js');

const isWindows = process.platform === 'win32';
const MAX_ERRORS_SHOWN = 5;
const CPPLINT_PY = path.join(__dirname, '..', 'cpplint', 'cpplint.py');

/** 解析 python 可执行（python / python3），都没有返回 null */
function resolvePython() {
  for (const cmd of ['python', 'python3']) {
    const r = spawnSync(cmd, ['--version'], { stdio: 'pipe', windowsHide: isWindows });
    if (!r.error && r.status === 0) return cmd;
  }
  return null;
}

/** 解析 cpplint stderr：`path:line:  message  [category] [conf]` → {line,category,message} */
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
 * 始终禁用的 cpplint 检查项（与全局版 cpplint 保持一致）。
 * - whitespace/indent_namespace: Google Style 不缩进 namespace 内容，
 *   但 clang-format 仅格式化变更行，旧代码可能仍有缩进；
 *   抑制此检查避免用户添加 NOLINT 注释后行超 80 字符的连锁冲突。
 */
const DEFAULT_FILTERS = ['-whitespace/indent_namespace'];

/**
 * 合并 filter：默认禁用项 + 按需 -legal/copyright + 调用方额外项，
 * 去重后拼成单个逗号分隔的 --filter 值
 * （cpplint 只接受一个 --filter）。无任何 filter 项时返回 null，由调用方决定不传 --filter。
 * @param {{suppressCopyright?:boolean, extraFilters?:string[]}} options
 * @returns {string|null}
 */
function buildFilterArg(options = {}) {
  const filters = [...DEFAULT_FILTERS];
  if (options.suppressCopyright) filters.push('-legal/copyright');
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
 * 直接对原文件真实路径跑 cpplint（不建临时副本）。
 *
 * 为何不用临时副本：cpplint 用文件名/路径计算期望的 header_guard 宏名，并用 basename
 * 匹配「主头文件」判断 include_order。临时 hash 路径名会让这两者全错（误报
 * build/header_guard 宏名与 build/include_order）。直接对真实路径跑则二者正确。
 *
 * BOM 处理（实测 cpplint.py 不认 UTF-8 BOM：BOM 在第一行行首会令 #ifndef 检测失败，
 * 误报 build/header_guard「No #ifndef header guard found」，即使 guard 实际存在）：
 * - 无 BOM（常见）：零写入，直接对真实路径跑。
 * - 有 BOM：原地剥 BOM → 跑 cpplint → finally 中按原字节恢复。剥/恢复均为同步写，
 *   try/finally 保证恢复；剥 BOM 后的文件仍是合法 UTF-8（仅缺 BOM，下次编辑会再补），
 *   非「损坏」文件。真实路径全程不变，故 header_guard/include_order 仍按真实文件名判断。
 *
 * filter 仅在 suppressCopyright 时含 -legal/copyright；无 filter 项时不传 --filter。
 * @param {string} filePath
 * @param {{root?:string, suppressCopyright?:boolean, extraFilters?:string[]}} options
 * @returns {Array<{line:number, category:string, message:string}>}
 */
function runCpplint(filePath, options = {}) {
  const python = resolvePython();
  if (!python || !fs.existsSync(CPPLINT_PY)) {
    process.stderr.write('[cpp-style-enforcer] python/cpplint 不可用，跳过 cpplint\n');
    return [];
  }

  let raw;
  try { raw = fs.readFileSync(filePath); } catch (_) { return []; }
  const { hadBom, body } = stripBom(raw);

  const args = [CPPLINT_PY, '--quiet'];
  if (options.root) args.push('--root=' + options.root);
  const filterArg = buildFilterArg(options);
  if (filterArg) args.push(filterArg);
  args.push(filePath);

  let violations = [];
  let stripped = false;
  try {
    // 仅当有 BOM 才原地剥除，避免 cpplint 误报 header_guard；无 BOM 时零写入。
    if (hadBom) {
      try { fs.writeFileSync(filePath, body); stripped = true; } catch (_) { /* 写失败则带 BOM 跑 */ }
    }
    const r = spawnSync(python, args, {
      stdio: 'pipe',
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: isWindows,
    });
    const stderr = (r.stderr || Buffer.alloc(0)).toString('utf-8');
    violations = parseCpplintOutput(stderr);
  } catch (_) {
    violations = [];
  } finally {
    // 恢复原始字节（含 BOM）。stripped 才需要恢复，按原 hadBom 拼回。
    if (stripped) {
      try { fs.writeFileSync(filePath, restoreBom(true, body)); } catch (_) {}
    }
  }
  return violations;
}

/**
 * 逐字去重（key=line:category:message）→ 取前 5 → 拼 reason（含「还有 N 条」）。
 * 全部为硬违规，必须修复。
 * @param {Array<{line:number, category:string, message:string}>} violations
 * @returns {string}
 */
function formatViolations(violations) {
  const seen = new Set();
  const unique = [];
  for (const v of violations) {
    const key = `${v.line}:${v.category}:${v.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(v);
  }
  const shown = unique.slice(0, MAX_ERRORS_SHOWN);
  const lines = shown.map((v) => `  - 行 ${v.line} [${v.category}] ${v.message}`);
  let reason = 'cpplint 检测到以下 C++ 风格违规，请修复：\n' + lines.join('\n');
  const remaining = unique.length - shown.length;
  if (remaining > 0) {
    reason += `\n  ... 还有 ${remaining} 条违规未显示，修复以上后重新编辑该文件以重新检查`;
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
