'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolvePython } = require('../lib/python');

const isWindows = process.platform === 'win32';
const MAX_ERRORS_SHOWN = 5;
const CPPLINT_PY = path.join(__dirname, '..', 'cpplint', 'cpplint.py');

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
 * 随附 cpplint 使用 utf-8-sig 读取源码，直接忽略 BOM；本步骤从不写文件，
 * 即使进程中断也不会移除 BOM，mtime、LF/CRLF 和原始字节均保持不变。
 *
 * filter 仅在 suppressCopyright 时含 -legal/copyright；无 filter 项时不传 --filter。
 * @param {string} filePath
 * @param {{root?:string, suppressCopyright?:boolean, extraFilters?:string[], timeoutMs?:number}} options
 * @returns {Array<{line:number, category:string, message:string}>}
 */
function runCpplint(filePath, options = {}) {
  const failure = (message, category = 'runtime/cpplint') => [{ line: 0, category, message }];
  let python;
  try { python = (options.resolvePython || resolvePython)(); } catch (error) {
    return failure(`无法检测 Python：${error.message || error}`);
  }
  if (!python || !fs.existsSync(CPPLINT_PY)) {
    return failure('Python/cpplint 不可用，本次检查未执行');
  }

  try { fs.accessSync(filePath, fs.constants.R_OK); } catch (_) {
    return failure('无法读取待检查文件，本次检查未执行');
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
      return failure('cpplint 执行超时，检查未完成', 'runtime/timeout');
    }
    if (r.error) return failure(`cpplint 无法执行：${r.error.code || r.error.message}`);
    const stderr = (r.stderr || Buffer.alloc(0)).toString('utf-8');
    const violations = parseCpplintOutput(stderr);
    if (r.status !== 0 && violations.length === 0) {
      return failure(`cpplint 异常结束（退出码 ${r.status}），检查未完成`);
    }
    if (/Skipping input|Can't open for reading|Error reading config|Invalid configuration|Line length must be numeric/i.test(stderr)) {
      return [...violations, ...failure('cpplint 未能读取源码或配置，检查未完成')];
    }
    return violations;
  } catch (error) {
    return failure(`cpplint 检查异常：${error.message || error}`);
  }
}

/**
 * 逐字去重（key=file:line:category:message）→ 取前 5 → 拼 reason（含「还有 N 条」）。
 * 全部为硬违规，必须修复。
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
    const where = v.file ? `${v.file}:${v.line}` : `行 ${v.line}`;
    return `  - ${where} [${v.category}] ${v.message}`;
  });
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
