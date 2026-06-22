'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const { stripBom, restoreBom } = require('../lib/bom_util.js');
const { changedLineRanges } = require('../lib/git.js');
const { detectClangFormat } = require('../lib/ensure_deps.js');

const isWindows = process.platform === 'win32';

/**
 * 将 formatted 的行尾风格还原成 source 的行尾风格。
 *
 * clang-format 部分版本 / BasedOnStyle 预设会把 CRLF 输出成 LF（DeriveLineEnding
 * 行为差异）。VS 项目源码多为 CRLF，行尾被悄悄改成 LF 会导致 git 整文件每行都 diff。
 * 此处不依赖 clang-format 配置，直接按输入行尾强制还原，覆盖所有版本与存量项目。
 *
 * 实现：用 latin1（字节安全）把输出统一到 LF，再按 source 风格决定是否还原成 CRLF。
 * latin1 双向映射不破坏 UTF-8 多字节，replace 只触碰 \r(0x0D)\n(0x0A)。
 *
 * @param {Buffer} formatted clang-format 的输出字节
 * @param {Buffer} source 剥 BOM 后的输入正文（作为行尾基准）
 * @returns {Buffer} 行尾与 source 一致的输出
 */
function matchLineEnding(formatted, source) {
  const sourceCRLF = source.includes('\r\n');
  let s = formatted.toString('latin1').replace(/\r\n/g, '\n'); // 统一到 LF
  if (sourceCRLF) s = s.replace(/\n/g, '\r\n');                // 还原成 CRLF
  return Buffer.from(s, 'latin1');
}

/**
 * BOM 感知的双模式 clang-format。
 * 剥 BOM → 无 BOM 正文经 stdin 喂 clang-format(stdout) → 与无 BOM 正文 diff
 * → 仅变化时 restoreBom 写回。clang-format 缺失/失败静默返回 false。不用 -i。
 *
 * 模式（由 opts.isNew 决定，缺省视为新文件）：
 * - 新文件：整文件全格，-style=file -fallback-style=Google，include 正常排序。
 * - 老文件：仅格 git 改动行（--lines=s:e），-style 内联 SortIncludes:Never
 *   强制 include 不排序；无改动行则不格式化返回 false。
 *
 * 行号说明：--lines 作用于 stdin 输入（已剥 BOM 的正文）。剥 BOM 仅去掉文件最前
 * 3 字节（BOM 在第一行行首，不增减行），故 git diff 的改动行号可直接用作 --lines。
 *
 * @param {string} filePath
 * @param {{isNew?:boolean, root?:string|null, detect?:function():({cmd:string,args:string[]}|null)}} [opts]
 * @returns {boolean} 是否改写了文件
 */
function applyClangFormat(filePath, opts) {
  const isNew = !opts || opts.isNew !== false; // 缺省 → 新文件整文件模式
  const root = opts && opts.root ? opts.root : null;
  // 只检测不安装：编辑 hook 不做 pip 安装，避免阻塞或超时。
  const detect = (opts && opts.detect) || detectClangFormat;
  let desc = null;
  try { desc = detect(); } catch (_) { desc = null; }
  if (!desc) return false; // clang-format 不可用 → 静默降级

  let raw;
  try { raw = fs.readFileSync(filePath); } catch (_) { return false; }
  const { hadBom, body } = stripBom(raw);

  let args;
  if (isNew) {
    args = ['-style=file', '-fallback-style=Google', `-assume-filename=${filePath}`];
  } else {
    const ranges = changedLineRanges(filePath, root);
    if (!ranges || ranges.length === 0) return false; // 无改动行 → 不格式化
    args = ['-style={BasedOnStyle: Google, SortIncludes: Never}', `-assume-filename=${filePath}`];
    for (const [s, e] of ranges) args.push(`--lines=${s}:${e}`);
  }

  const r = spawnSync(
    desc.cmd,
    [...desc.args, ...args],
    { input: body, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 32 * 1024 * 1024, windowsHide: isWindows }
  );
  // clang-format 执行失败 → 静默跳过
  if (r.error || r.status !== 0 || !r.stdout) return false;

  const rawFormatted = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout);
  // 行尾还原成输入风格（防 CRLF 被 clang-format 改成 LF 致全文 diff）
  const formatted = matchLineEnding(rawFormatted, body);
  if (formatted.equals(body)) return false; // 还原行尾后仍无变化 → 不写

  try {
    fs.writeFileSync(filePath, restoreBom(hadBom, formatted));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { applyClangFormat, matchLineEnding };
