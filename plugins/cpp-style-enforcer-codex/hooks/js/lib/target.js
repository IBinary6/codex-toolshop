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
 * 从 hook stdin JSON 提取被编辑的文件路径；Codex apply_patch 的 command 可含多个文件。
 * 始终返回绝对路径：相对路径以 input.cwd（hook 协议提供；通常 file_path 已经是绝对路径）
 * 为基准解析，避免相对路径被原样漏过导致 repoRoot/配置查找/.clang-format 生成全错位。
 * @param {object} input
 * @returns {string[]}
 */
function resolveFilePaths(input) {
  if (!input || typeof input !== 'object') return [];
  const cwd = input.cwd || process.cwd();
  const toAbs = (p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p));
  const paths = [];
  const add = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const resolved = toAbs(value.trim());
    if (!paths.includes(resolved)) paths.push(resolved);
  };

  const t = input.tool_input;
  if (t && typeof t === 'object') {
    add(t.file_path || t.path || null);
    if (t.relative_path) add(t.relative_path);
    if (typeof t.command === 'string') {
      for (const line of t.command.split(/\r?\n/)) {
        let match = line.match(/^\*\*\* (?:Add|Update) File:\s+(.+?)\s*$/);
        if (!match) match = line.match(/^\*\*\* Move to:\s+(.+?)\s*$/);
        if (match) add(match[1]);
      }
    }
  } else if (typeof t === 'string') {
    add(t);
  }
  add(input.file_path || input.path || null);
  return paths;
}

function resolveFilePath(input) {
  return resolveFilePaths(input)[0] || null;
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

module.exports = { resolveFilePath, resolveFilePaths, shouldHandle, CPP_EXTENSIONS, EXCLUDED_DIRS, SKIPPED_FILES };
