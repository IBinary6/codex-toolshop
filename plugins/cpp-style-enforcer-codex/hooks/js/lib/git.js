'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';

function canonicalPath(filePath) {
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    return realpath(filePath);
  } catch (_) {
    return path.resolve(filePath);
  }
}

function gitDir(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
      ? filePath : path.dirname(filePath);
  } catch (_) {
    return path.dirname(filePath);
  }
}

/**
 * Search upward from a file for the Git repository root; return null outside Git.
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
 * A file is new when it is absent from HEAD (committed history).
 * This includes untracked, staged-but-uncommitted, and initial-commit files. Outside Git (root=null), treat it as new.
 * Without a commit (invalid HEAD), cat-file fails and all files are treated as new.
 * @param {string} filePath
 * @param {string|null} root
 * @returns {boolean}
 */
function isNew(filePath, root) {
  if (!root) return true;
  // A Windows runner may pass TEMP as an 8.3 short path such as RUNNER~1, while git rev-parse
  // returns a long path. Resolve real paths first so path.relative does not produce a false ../../RUNNER~1/... path.
  const rel = path.relative(canonicalPath(root), canonicalPath(filePath))
    .split(path.sep).join('/');
  const r = spawnSync('git', ['cat-file', '-e', `HEAD:${rel}`], {
    cwd: root, stdio: 'pipe', timeout: 3000, windowsHide: isWindows,
  });
  return r.status !== 0;
}

/**
 * Changed line ranges [[start,end],...] in worktree plus staging relative to HEAD.
 * Parse @@ +start,len @@ from git diff -U0 HEAD; skip len=0 (pure deletions).
 * Return null outside Git or on diff failure; return [] when unchanged.
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
    if (len === 0) continue; // Pure deletion: no corresponding line on the new-file side.
    ranges.push([start, start + len - 1]);
  }
  return ranges;
}

module.exports = { repoRoot, isNew, changedLineRanges };
