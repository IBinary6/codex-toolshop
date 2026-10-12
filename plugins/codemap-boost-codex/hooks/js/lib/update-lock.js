'use strict';

// The lock that one runtime updater, or one pointer write, holds at a time. It lives apart from runtime-updates.js
// so the MCP catalog can record the first installed runtime under the same lock without loading the updater.

const fs = require('fs');
const path = require('path');
const { releaseLock, transferLock, tryAcquireLock } = require('./lock');
const { pluginDataDir } = require('./runtime');

const UPDATE_LOCK_FILE = 'runtime-update.lock';
const UPDATE_LOCK_STALE_MS = 30 * 60 * 1000;

function updateLockPath(options = {}) {
  return path.join(options.pluginDataDir || pluginDataDir(options), UPDATE_LOCK_FILE);
}

function acquireUpdateLock(options = {}) {
  const file = options.lockPath || updateLockPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The owner is the scheduling process until it hands the lock to the updater child, so a young lock is never taken.
  const token = tryAcquireLock(file, { token: options.token, bootMs: options.lockStaleMs || UPDATE_LOCK_STALE_MS });
  return token ? { file, token } : null;
}

function releaseUpdateLock(lock) {
  if (lock) releaseLock(lock.file, lock.token);
}

function transferUpdateLock(lock, pid) {
  return !!lock && transferLock(lock.file, lock.token, pid);
}

function adoptedUpdateLock(token, options = {}) {
  if (!token) return null;
  const file = options.lockPath || updateLockPath(options);
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record.token === token && Number(record.pid) === process.pid ? { file, token } : null;
  } catch (_) { return null; }
}

module.exports = {
  UPDATE_LOCK_FILE,
  UPDATE_LOCK_STALE_MS,
  acquireUpdateLock,
  adoptedUpdateLock,
  releaseUpdateLock,
  transferUpdateLock,
  updateLockPath,
};
