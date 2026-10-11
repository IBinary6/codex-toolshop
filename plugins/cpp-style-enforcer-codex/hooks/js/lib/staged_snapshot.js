'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';
const MAX_BLOB_SIZE = 32 * 1024 * 1024;

/**
 * Convert a worktree path to a safe repository-relative path for Git index queries.
 * @param {string} root
 * @param {string} filePath
 * @returns {string}
 */
function relativeGitPath(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`File is outside the repository root: ${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

/**
 * Read a blob at a path in the Git index; return null if absent.
 * @param {string} root
 * @param {string} relativePath
 * @returns {Buffer|null}
 */
function readIndexBlob(root, relativePath) {
  const result = spawnSync('git', ['cat-file', 'blob', `:${relativePath}`], {
    cwd: root,
    encoding: null,
    maxBuffer: MAX_BLOB_SIZE,
    timeout: 5000,
    windowsHide: isWindows,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) return null;
  return result.stdout;
}

/**
 * List all paths in the current index to find applicable CPPLINT.cfg files.
 * @param {string} root
 * @returns {string[]}
 */
function listIndexPaths(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--full-name'], {
    cwd: root,
    encoding: null,
    timeout: 5000,
    windowsHide: isWindows,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error('Could not read the Git index file list');
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

/**
 * Write an index blob into the snapshot, preserving repository-relative path and original bytes.
 * @param {string} snapshotRoot
 * @param {string} relativePath
 * @param {Buffer} contents
 * @returns {string}
 */
function writeSnapshotFile(snapshotRoot, relativePath, contents) {
  const target = path.resolve(snapshotRoot, ...relativePath.split('/'));
  const rootWithSeparator = `${path.resolve(snapshotRoot)}${path.sep}`;
  if (!target.startsWith(rootWithSeparator)) {
    throw new Error(`Invalid repository-relative path: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

/**
 * Create a temporary snapshot with read-only Git index semantics.
 * The snapshot contains C++ files to check and every CPPLINT.cfg in the index so cpplint retains
 * header guard, include_order, and directory configuration semantics. Callers must clean up in finally.
 * @param {string} root
 * @param {string[]} filePaths Absolute worktree paths to check
 * @returns {{root:string, files:Array<{relativePath:string,filePath:string}>, cleanup:Function}}
 */
function createStagedSnapshot(root, filePaths) {
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-style-staged-'));
  try {
    const relativeFiles = filePaths.map((filePath) => relativeGitPath(root, filePath));
    const configFiles = listIndexPaths(root).filter((relativePath) => (
      path.posix.basename(relativePath) === 'CPPLINT.cfg'
    ));
    const pathsToCopy = [...new Set([...relativeFiles, ...configFiles])];

    for (const relativePath of pathsToCopy) {
      const blob = readIndexBlob(root, relativePath);
      if (!blob) throw new Error(`Could not read Git index blob: ${relativePath}`);
      writeSnapshotFile(snapshotRoot, relativePath, blob);
    }

    const files = relativeFiles.map((relativePath) => ({
      relativePath,
      filePath: path.resolve(snapshotRoot, ...relativePath.split('/')),
    }));
    return {
      root: snapshotRoot,
      files,
      cleanup: () => fs.rmSync(snapshotRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  relativeGitPath,
  readIndexBlob,
  listIndexPaths,
  createStagedSnapshot,
};
