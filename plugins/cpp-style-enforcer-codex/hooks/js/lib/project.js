'use strict';

const fs = require('fs');
const path = require('path');

const _cache = new Map(); // Per-process cache; each hook runs in a separate process.

/**
 * Search upward from an edited file for CMakeLists.txt independently of Git.
 * @param {string} filePath
 * @returns {string|null} CMake project root (directory containing CMakeLists.txt), or null
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
 * Conservatively classify a directory as C/C++ when its root or common subdirectories contain a C++ marker.
 * Markers include CMakeLists.txt, *.vcxproj/*.sln, or C/C++ source at root or under src/include/source.
 * Scan only root and one level of common directories; return false if absent to avoid creating files in non-C++ projects.
 *
 * @param {string|null} root Project root (Git repository root)
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
