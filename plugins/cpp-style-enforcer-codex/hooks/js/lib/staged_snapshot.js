'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';
const MAX_BLOB_SIZE = 32 * 1024 * 1024;

/**
 * 将工作区路径转换为安全的仓库相对路径，供 Git index 查询使用。
 * @param {string} root
 * @param {string} filePath
 * @returns {string}
 */
function relativeGitPath(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`文件不在仓库根目录内：${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

/**
 * 读取 Git index 中指定路径的 blob；返回 null 表示该路径当前不存在于 index。
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
 * 列出当前 index 中的全部路径，用于查找适用的 CPPLINT.cfg。
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
    throw new Error('无法读取 Git index 文件列表');
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

/**
 * 将 index blob 写入快照，保持仓库相对路径和原始字节。
 * @param {string} snapshotRoot
 * @param {string} relativePath
 * @param {Buffer} contents
 * @returns {string}
 */
function writeSnapshotFile(snapshotRoot, relativePath, contents) {
  const target = path.resolve(snapshotRoot, ...relativePath.split('/'));
  const rootWithSeparator = `${path.resolve(snapshotRoot)}${path.sep}`;
  if (!target.startsWith(rootWithSeparator)) {
    throw new Error(`非法仓库相对路径：${relativePath}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

/**
 * 创建只读语义上的 Git index 临时快照。
 * 快照包含要检查的 C++ 文件，以及 index 中全部 CPPLINT.cfg，供 cpplint 保持
 * header guard、include_order 和目录级配置语义。调用方必须在 finally 中清理。
 * @param {string} root
 * @param {string[]} filePaths 要检查的工作区绝对路径
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
      if (!blob) throw new Error(`无法读取 Git index blob：${relativePath}`);
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
