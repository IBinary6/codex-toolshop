'use strict';

const fs = require('node:fs');
const path = require('node:path');

const realRmSync = fs.rmSync;
let failedSnapshot = null;

/**
 * Fail only the first staged snapshot cleanup to verify fail-closed commit checks.
 *
 * @param {string} target Path to remove
 * @param {object} options rmSync options
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
