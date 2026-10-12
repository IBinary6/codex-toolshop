'use strict';

// File locks between processes, shared by the graph refresh, the runtime installers, the background updater and
// the Serena project preparation. A lock is a file created with the exclusive flag, holding `{ pid, token }`.
//
// A lock whose owner died must be removed by somebody. Doing that as "read the owner, decide it is gone, delete"
// is not safe on its own: two waiters can both read the dead owner, one deletes the file and takes the lock, and the
// other then deletes the lock it just took, so both run at once. A guard directory therefore serializes the
// judge-and-remove step (the same scheme as dbg-codex/scripts/launch.cjs): while one waiter holds the guard, no
// other waiter can remove anything, and the waiter that comes next sees the new, fresh lock and leaves it alone.

const crypto = require('crypto');
const fs = require('fs');

const DEFAULT_BOOT_MS = 5000;
// The guard is held for a few milliseconds; one older than this belongs to a process that died inside it.
const GUARD_STALE_MS = 60 * 1000;

/**
 * Block the thread without spinning.
 * @example sleepSync(100)
 */
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * True when the process exists. EPERM means it exists but belongs to someone else, so it is alive.
 * @example isPidAlive(process.pid) // true
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && error.code === 'EPERM';
  }
}

/**
 * Owner recorded in a lock file: the JSON record, or the bare pid that older versions wrote.
 * An empty or unreadable record gives pid 0, which is never alive.
 * @example readOwner('/tmp/x.lock') // { pid: 4242, token: 'b1c2...' }
 */
function readOwner(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) {}
  if (parsed && typeof parsed === 'object') {
    return { pid: Number(parsed.pid) || 0, token: typeof parsed.token === 'string' ? parsed.token : '' };
  }
  return { pid: Number.parseInt(raw, 10) || 0, token: '' };
}

/**
 * Remove the lock when its owner is gone. A lock younger than bootMs is never touched: its owner may still be
 * writing it or handing it to a child process that has not recorded its own pid yet. A live owner keeps the lock
 * unless staleMs is set and the lock is older than that (a recycled pid cannot be told from a live owner).
 * Returns true when the caller should try to take the lock again right away.
 * @example reclaimAbandonedLock('/tmp/x.lock', { bootMs: 5000 })
 */
function reclaimAbandonedLock(file, { bootMs = DEFAULT_BOOT_MS, staleMs = 0 } = {}) {
  const guard = `${file}.reclaim`;
  try {
    fs.mkdirSync(guard);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') return false;
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) fs.rmdirSync(guard);
    } catch (_) {}
    return false;
  }
  try {
    let ageMs;
    try {
      ageMs = Date.now() - fs.statSync(file).mtimeMs;
    } catch (error) {
      return !!error && error.code === 'ENOENT'; // released in the meantime: take it now; anything else: keep waiting
    }
    if (ageMs <= bootMs) return false;
    let owner = { pid: 0 };
    try { owner = readOwner(file); } catch (_) {}
    if (isPidAlive(owner.pid) && !(staleMs > 0 && ageMs > staleMs)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } finally {
    try { fs.rmdirSync(guard); } catch (_) {}
  }
}

/**
 * One attempt to take the lock, removing an abandoned one first. Returns the owner token, or null when somebody
 * else holds it. Pass the token to releaseLock; options: { token, bootMs, staleMs } as in reclaimAbandonedLock.
 * @example const token = tryAcquireLock('/tmp/x.lock', { bootMs: 5000 }); if (token) releaseLock('/tmp/x.lock', token)
 */
function tryAcquireLock(file, options = {}) {
  const token = options.token || crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }), { flag: 'wx' });
      return token;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return null;
    }
    if (!reclaimAbandonedLock(file, options)) return null;
  }
  return null;
}

/**
 * Take the lock, waiting up to waitMs (one attempt when it is 0). Returns the owner token or null.
 * @example acquireLockSync('/tmp/x.lock', { waitMs: 2000, pollMs: 50 })
 */
function acquireLockSync(file, options = {}) {
  const deadline = Date.now() + Math.max(0, options.waitMs || 0);
  for (;;) {
    const token = tryAcquireLock(file, options);
    if (token) return token;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    sleepSync(Math.min(options.pollMs || 50, remaining));
  }
}

/**
 * Remove the lock if, and only if, this token still owns it.
 * @example releaseLock('/tmp/x.lock', token)
 */
function releaseLock(file, token) {
  try {
    if (readOwner(file).token === token) fs.rmSync(file, { force: true });
  } catch (_) {}
}

/**
 * Record another process as the owner of a lock this token holds (handing it to a spawned child).
 * @example transferLock('/tmp/x.lock', token, child.pid) // true
 */
function transferLock(file, token, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || record.token !== token) return false;
    fs.writeFileSync(file, JSON.stringify({ ...record, pid }), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  acquireLockSync,
  isPidAlive,
  reclaimAbandonedLock,
  releaseLock,
  sleepSync,
  transferLock,
  tryAcquireLock,
};
