'use strict';

const fs = require('node:fs');
const path = require('node:path');

const realRmSync = fs.rmSync;
let failedSnapshot = null;

/**
 * 仅让第一次 staged snapshot 清理失败，用于验证提交检查的 fail-closed 语义。
 *
 * @param {string} target 待删除路径
 * @param {object} options rmSync 选项
 * @returns {void}
 */
fs.rmSync = function failFirstSnapshotCleanup(target, options) {
  if (!failedSnapshot && path.basename(String(target)).startsWith('cpp-style-staged-')) {
    failedSnapshot = target;
    throw new Error('simulated snapshot cleanup failure');
  }
  return realRmSync.call(fs, target, options);
};

process.once('exit', () => {
  if (!failedSnapshot) return;
  try { realRmSync.call(fs, failedSnapshot, { recursive: true, force: true }); } catch (_) {}
});
