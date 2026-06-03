'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';

function gitDir(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
      ? filePath : path.dirname(filePath);
  } catch (_) {
    return path.dirname(filePath);
  }
}

/**
 * 从文件向上找 git 仓库根。非 git 仓库返回 null。
 * @param {string} filePath
 * @returns {string|null}
 */
function repoRoot(filePath) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: gitDir(filePath), stdio: 'pipe', timeout: 3000, windowsHide: isWindows,
  });
  if (r.status !== 0) return null;
  return (r.stdout || Buffer.alloc(0)).toString('utf-8').trim() || null;
}

/**
 * 新文件判定：文件不在 HEAD（已提交历史）中即为新文件。
 * 涵盖未跟踪、已暂存未提交、首次提交。非 git 仓库(root=null) → true（视为新）。
 * 仓库无任何 commit（HEAD 无效）→ cat-file 失败 → 所有文件视为新。
 * @param {string} filePath
 * @param {string|null} root
 * @returns {boolean}
 */
function isNew(filePath, root) {
  if (!root) return true;
  const rel = path.relative(root, filePath).split(path.sep).join('/');
  const r = spawnSync('git', ['cat-file', '-e', `HEAD:${rel}`], {
    cwd: root, stdio: 'pipe', timeout: 3000, windowsHide: isWindows,
  });
  return r.status !== 0;
}

/**
 * 工作区+暂存区相对 HEAD 的改动行范围 [[start,end],...]。
 * 基于 git diff -U0 HEAD 解析 @@ +start,len @@；len=0（纯删除）跳过。
 * 非 git(root=null) 或 diff 失败返回 null；无改动返回 []。
 * @param {string} filePath
 * @param {string|null} root
 * @returns {Array<[number,number]>|null}
 */
function changedLineRanges(filePath, root) {
  if (!root) return null;
  const r = spawnSync('git', ['diff', '-U0', 'HEAD', '--', filePath], {
    cwd: root, stdio: 'pipe', timeout: 5000, windowsHide: isWindows,
  });
  if (r.status !== 0) return null;
  const out = (r.stdout || Buffer.alloc(0)).toString('utf-8');
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  const ranges = [];
  let m;
  while ((m = re.exec(out)) !== null) {
    const start = parseInt(m[1], 10);
    const len = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    if (len === 0) continue; // 纯删除：新文件侧无对应行
    ranges.push([start, start + len - 1]);
  }
  return ranges;
}

module.exports = { repoRoot, isNew, changedLineRanges };
