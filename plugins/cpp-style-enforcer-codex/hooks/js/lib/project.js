'use strict';

const fs = require('fs');
const path = require('path');

const _cache = new Map(); // 单进程内缓存（每次 hook 是独立进程）

/**
 * 从被编辑文件向上逐级找 CMakeLists.txt，与 git 解耦。
 * @param {string} filePath
 * @returns {string|null} CMake 项目根（含 CMakeLists.txt 的目录）；找不到 null
 */
function findCMakeRoot(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  if (_cache.has(filePath)) return _cache.get(filePath);
  let result = null;
  try {
    let dir = path.dirname(path.resolve(filePath));
    let prev = null;
    while (dir && dir !== prev) {
      if (fs.existsSync(path.join(dir, 'CMakeLists.txt'))) {
        result = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
        break;
      }
      prev = dir;
      dir = path.dirname(dir);
    }
  } catch (_) {
    result = null;
  }
  _cache.set(filePath, result);
  return result;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isCMakeProject(filePath) {
  return findCMakeRoot(filePath) !== null;
}

const _CPP_SRC_EXT = new Set(['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hh', '.hxx']);

/**
 * 保守判断给定目录是否为 C/C++ 项目：根或常见子目录有 C++ 标志。
 * 标志（任一即可）：CMakeLists.txt、*.vcxproj/*.sln、根或 src/include/source 下有 C/C++ 源文件。
 * 仅浅层扫描（根 + 一层常见目录），找不到 → false（保守，宁可漏不可在非 C++ 项目乱建）。
 *
 * @param {string|null} root 项目根（git 仓库根）
 * @returns {boolean}
 */
function isCppProjectDir(root) {
  if (!root || typeof root !== 'string') return false;
  try {
    if (fs.existsSync(path.join(root, 'CMakeLists.txt'))) return true;
    const dirsToScan = [root, path.join(root, 'src'), path.join(root, 'include'), path.join(root, 'source')];
    for (const dir of dirsToScan) {
      let entries;
      try {
        entries = fs.readdirSync(dir);
      } catch (_) {
        continue;
      }
      for (const name of entries) {
        const ext = path.extname(name).toLowerCase();
        if (ext === '.vcxproj' || ext === '.sln') return true;
        if (_CPP_SRC_EXT.has(ext)) return true;
      }
    }
  } catch (_) {
    return false;
  }
  return false;
}

module.exports = { findCMakeRoot, isCMakeProject, isCppProjectDir };
