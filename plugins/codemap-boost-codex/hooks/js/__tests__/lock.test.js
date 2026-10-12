'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lockModule = path.resolve(__dirname, '../lib/lock.js');
const {
  acquireLockSync, isPidAlive, releaseLock, transferLock, tryAcquireLock,
} = require(lockModule);

const DEAD_PID = 2147483646;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-lock-'));
let counter = 0;
const lockPath = () => path.join(tmp, `lock-${counter++}`);
const age = (file, ms) => { const when = new Date(Date.now() - ms); fs.utimesSync(file, when, when); };
const seed = (file, content, ageMs) => { fs.writeFileSync(file, content); if (ageMs) age(file, ageMs); };
const HOUR = 60 * 60 * 1000;

function semantics() {
  const file = lockPath();
  const token = tryAcquireLock(file);
  assert.ok(token, 'a free lock is taken');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  assert.equal(tryAcquireLock(file), null, 'a held lock is not taken');
  releaseLock(file, 'someone-else');
  assert.ok(fs.existsSync(file), 'only the owner token releases');
  releaseLock(file, token);
  assert.ok(!fs.existsSync(file));

  const dead = lockPath();
  seed(dead, JSON.stringify({ pid: DEAD_PID, token: 'gone' }), HOUR);
  assert.ok(tryAcquireLock(dead, { bootMs: 5000 }), 'an old lock of a dead owner is reclaimed');
  assert.ok(!fs.existsSync(`${dead}.reclaim`), 'the guard is removed afterwards');

  const young = lockPath();
  seed(young, JSON.stringify({ pid: DEAD_PID, token: 'gone' }), 0);
  assert.equal(tryAcquireLock(young, { bootMs: 5000 }), null, 'a young lock is never reclaimed: its owner may be handing it over');

  const live = lockPath();
  seed(live, JSON.stringify({ pid: process.pid, token: 'me' }), HOUR);
  assert.equal(tryAcquireLock(live, { bootMs: 1 }), null, 'a live owner keeps an old lock');
  assert.ok(tryAcquireLock(live, { bootMs: 1, staleMs: HOUR / 2 }), 'unless staleMs says a live pid cannot be trusted that long');

  const legacy = lockPath();
  seed(legacy, String(DEAD_PID), HOUR);
  assert.ok(tryAcquireLock(legacy, { bootMs: 5000 }), 'the bare pid older versions wrote is understood');
  const legacyLive = lockPath();
  seed(legacyLive, String(process.pid), HOUR);
  assert.equal(tryAcquireLock(legacyLive, { bootMs: 5000 }), null, 'a bare pid of a live process keeps the lock');

  const empty = lockPath();
  seed(empty, '', HOUR);
  assert.ok(tryAcquireLock(empty, { bootMs: 5000 }), 'an old lock nobody can identify is reclaimed');
  const writing = lockPath();
  seed(writing, '', 0);
  assert.equal(tryAcquireLock(writing, { bootMs: 5000 }), null, 'a lock that is still being written is left alone');

  const abandonedGuard = lockPath();
  seed(abandonedGuard, JSON.stringify({ pid: DEAD_PID, token: 'gone' }), HOUR);
  fs.mkdirSync(`${abandonedGuard}.reclaim`);
  age(`${abandonedGuard}.reclaim`, HOUR);
  assert.equal(tryAcquireLock(abandonedGuard, { bootMs: 5000 }), null, 'a guard held by someone blocks the attempt');
  assert.ok(!fs.existsSync(`${abandonedGuard}.reclaim`), 'but one left by a process that died is removed');
  assert.ok(tryAcquireLock(abandonedGuard, { bootMs: 5000 }), 'and the next attempt succeeds');

  const waited = lockPath();
  const holder = tryAcquireLock(waited);
  const before = Date.now();
  assert.equal(acquireLockSync(waited, { waitMs: 120, pollMs: 20 }), null);
  assert.ok(Date.now() - before >= 100, 'a waiter waits for its budget');
  assert.equal(acquireLockSync(waited, { waitMs: 0 }), null, 'waitMs 0 is a single attempt');
  releaseLock(waited, holder);
  assert.ok(acquireLockSync(waited, { waitMs: 0 }));

  const handed = lockPath();
  const owner = tryAcquireLock(handed);
  assert.equal(transferLock(handed, 'wrong', 4242), false);
  assert.equal(transferLock(handed, owner, 0), false);
  assert.equal(transferLock(handed, owner, 4242), true);
  const record = JSON.parse(fs.readFileSync(handed, 'utf8'));
  assert.deepEqual([record.pid, record.token], [4242, owner]);

  const originalKill = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); };
    assert.equal(isPidAlive(4242), true, 'EPERM means the process exists');
    process.kill = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
    assert.equal(isPidAlive(4242), false);
  } finally { process.kill = originalKill; }
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(process.pid), true);
}

// Waiters that all find the same abandoned lock must still take turns. Reading the owner, deciding it is gone and
// deleting the file without a guard lets one waiter delete the lock another has just taken: the two then hold it
// at once, in roughly one in five trials with six processes.
const CHILD = `
const { acquireLockSync, releaseLock, sleepSync } = require(${JSON.stringify(lockModule)});
const [file, startAt] = [process.argv[1], Number(process.argv[2])];
sleepSync(startAt - Date.now() - 5);
while (Date.now() < startAt) {}
const token = acquireLockSync(file, { waitMs: 5000, pollMs: 2, bootMs: 5000 });
const result = { won: false };
if (token) {
  result.won = true;
  result.start = Date.now();
  sleepSync(30);
  result.end = Date.now();
  releaseLock(file, token);
}
process.stdout.write(JSON.stringify(result));
`;

function race(trial, processes) {
  const file = path.join(tmp, `race-${trial}`);
  seed(file, JSON.stringify({ pid: DEAD_PID, token: 'stale' }), HOUR);
  const startAt = Date.now() + 1500;
  return Promise.all(Array.from({ length: processes }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD, file, String(startAt)], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.on('close', () => { try { resolve(JSON.parse(text)); } catch (_) { resolve({ won: false }); } });
  })));
}

async function exclusion() {
  const TRIALS = 12;
  const PROCESSES = 6;
  const trials = await Promise.all(Array.from({ length: TRIALS }, (_, trial) => race(trial, PROCESSES)));
  trials.forEach((results, trial) => {
    const winners = results.filter((result) => result.won).sort((a, b) => a.start - b.start);
    assert.equal(winners.length, PROCESSES, `trial ${trial}: every waiter eventually gets its turn`);
    for (let i = 1; i < winners.length; i += 1) {
      assert.ok(winners[i].start >= winners[i - 1].end, `trial ${trial}: two processes held the lock at once`);
    }
  });
}

(async () => {
  try {
    semantics();
    await exclusion();
    console.log('lock.test.js PASS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
