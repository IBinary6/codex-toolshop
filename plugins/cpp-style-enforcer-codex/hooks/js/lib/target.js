'use strict';

const path = require('path');

/** C / C++ 源文件扩展名（含头文件） */
const CPP_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx']);

/** 跳过检查的目录名（第三方 / 构建产物 / 包管理器） */
const EXCLUDED_DIRS = new Set([
  'node_modules', 'build', 'dist', 'out', 'bin', 'obj',
  '.git', 'target', 'third_party', 'thirdparty', 'external',
  'vendor', 'deps', 'packages',
]);

/** 跳过的特定文件名（VS 自动生成 / 不该被风格化） */
const SKIPPED_FILES = new Set(['resource.h', 'targetver.h', 'stdafx.h', 'pch.h']);

/**
 * 从 hook stdin JSON 提取被编辑的文件路径（Write/Edit/MultiEdit/NotebookEdit/MCP）。
 * 不处理 Bash command（PostToolUse 已去掉 Bash matcher）。
 * 始终返回绝对路径：相对路径以 input.cwd（hook 协议提供，正常 Claude Code 传绝对 file_path）
 * 为基准解析，避免相对路径被原样漏过导致 repoRoot/配置查找/.clang-format 生成全错位。
 * @param {object} input
 * @returns {string|null}
 */
function resolveFilePath(input) {
  if (!input || typeof input !== 'object') return null;
  const cwd = input.cwd || process.cwd();
  const toAbs = (p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p));
  const t = input.tool_input;
  if (t && typeof t === 'object') {
    const direct = t.file_path || t.path || null;
    if (direct) return toAbs(direct);
    if (t.relative_path) return path.resolve(cwd, t.relative_path);
  }
  if (typeof t === 'string') return toAbs(t);
  const fallback = input.file_path || input.path || null;
  return fallback ? toAbs(fallback) : null;
}

/**
 * 是否应处理该文件：扩展名命中 && 非 SKIPPED_FILES && 路径无 EXCLUDED_DIRS。
 * @param {string} filePath
 * @returns {boolean}
 */
function shouldHandle(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const ext = path.extname(filePath).toLowerCase();
  if (!CPP_EXTENSIONS.has(ext)) return false;
  if (SKIPPED_FILES.has(path.basename(filePath).toLowerCase())) return false;
  for (const part of filePath.split(/[/\\]/)) {
    if (EXCLUDED_DIRS.has(part.toLowerCase())) return false;
  }
  return true;
}

module.exports = { resolveFilePath, shouldHandle, CPP_EXTENSIONS, EXCLUDED_DIRS, SKIPPED_FILES };
