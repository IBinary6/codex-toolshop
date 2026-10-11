'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const path = require('node:path');
const { serenaRuntimePaths } = require('../lib/serena-runtime');
const {
  OWNER_ENV, createOwner, inspectOwned, inspectIdentities, cleanupOwned,
} = require('../../../scripts/serena-processes.cjs');

const fixture = path.join(__dirname, 'serena_process_fixture.py');
const opts = { timeoutMs: 6000, intervalMs: 50, termGraceMs: 350 };

function testPython(candidate) {
  try {
    execFileSync(candidate, ['-c', 'import psutil; print(psutil.__version__)'], { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch (_) { return false; }
}

function resolvePython() {
  if (process.env.CODEMAP_SERENA_TEST_PYTHON) {
    const candidate = process.env.CODEMAP_SERENA_TEST_PYTHON;
    assert.ok(testPython(candidate), 'CODEMAP_SERENA_TEST_PYTHON must run Python with psutil');
    return candidate;
  }
  for (const candidate of [serenaRuntimePaths().python, 'python3', 'python']) {
    if (testPython(candidate)) return candidate;
  }
  throw new Error('Serena process tests require Python with psutil; install psutil or set CODEMAP_SERENA_TEST_PYTHON');
}

const python = resolvePython();

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture root did not exit')), 3000);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function eventually(action, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await action();
    if (predicate(value)) return value;
    await wait(40);
  }
  throw new Error('Timed out waiting for fixture process');
}

/** Clean up all owners before reporting errors; keep the primary failure first. */
async function finishOwned(owners, cleanup, verify, primaryError, primaryStage) {
  const failures = primaryError ? [primaryError] : [];
  for (const [index, owner] of owners.entries()) {
    try { await cleanup(owner); }
    catch (error) { failures.push(new Error(`cleanup-owner-${index} failed`, { cause: error })); }
  }
  try { await verify(); }
  catch (error) { failures.push(new Error('cleanup-verify failed', { cause: error })); }
  if (failures.length > 0) {
    throw new AggregateError(failures, primaryError
      ? `serena_processes main stage ${primaryStage} failed`
      : 'serena_processes cleanup failed');
  }
}

async function testFinishOwnedPreservesFirstFailure() {
  const original = new Error('original failure');
  const calls = [];
  await assert.rejects(finishOwned(['first', 'second', 'third'], async (owner) => {
    calls.push(owner);
    if (owner === 'first') throw new Error('cleanup failure');
  }, async () => { calls.push('verify'); }, original, 'early-inspect'), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /main stage early-inspect failed/);
    assert.equal(error.errors[0], original);
    assert.match(error.errors[1].message, /cleanup-owner-0 failed/);
    return true;
  });
  assert.deepEqual(calls, ['first', 'second', 'third', 'verify']);
  await assert.rejects(finishOwned(['first'], async () => {
    throw new Error('cleanup only');
  }, async () => {}, null, 'unused'), /serena_processes cleanup failed/);
}

function launch(mode, childMode, owner) {
  const env = { ...process.env, [OWNER_ENV]: owner };
  const root = spawn(python, ['-u', fixture, mode, childMode], {
    env, stdio: ['pipe', 'pipe', 'ignore'], detached: true,
  });
  const lines = [];
  const pending = [];
  let output = '';
  let closed = false;
  let failure;
  function deliver(line) {
    const pid = Number(line);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      failure = new Error('Fixture produced invalid child PID');
    } else if (pending.length > 0) {
      const waiter = pending.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(pid);
    } else {
      lines.push(pid);
    }
  }
  root.stdout.on('data', (chunk) => {
    output += chunk;
    let newline;
    while ((newline = output.indexOf('\n')) !== -1) {
      deliver(output.slice(0, newline).trim());
      output = output.slice(newline + 1);
    }
  });
  root.once('error', (error) => { failure = error; });
  root.once('close', () => {
    closed = true;
    for (const waiter of pending.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(failure || new Error('Fixture exited without child PID'));
    }
  });
  function nextPid() {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (closed || failure) return Promise.reject(failure || new Error('Fixture exited without child PID'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = pending.indexOf(waiter);
        if (index !== -1) pending.splice(index, 1);
        reject(new Error('Fixture produced no child PID'));
      }, 3000);
      pending.push(waiter);
    });
  }
  return { root, childPid: nextPid(), nextPid };
}

async function run() {
  await testFinishOwnedPreservesFirstFailure();
  const selfIdentity = JSON.parse(execFileSync(python, ['-c',
    'import json,psutil,sys; p=psutil.Process(int(sys.argv[1])); print(json.dumps({"pid":p.pid,"create_time":p.create_time()}))',
    String(process.pid)], { encoding: 'utf8' }));
  assert.deepEqual(await inspectIdentities(python, [selfIdentity]), [{ ...selfIdentity, ...(process.platform === 'win32' ? {} : { uid: process.getuid() }) }]);
  assert.deepEqual(await inspectIdentities(python, [{ ...selfIdentity, create_time: selfIdentity.create_time + 1 }]), []);
  await assert.rejects(inspectIdentities(python, [{ pid: 0, create_time: 1, secret: 'PRIVATE_VALUE' }]), (error) => {
    assert.match(error.message, /helper identities failed \(ValueError\)/);
    assert.doesNotMatch(error.message, /PRIVATE_VALUE/);
    return true;
  });
  const wrongCaller = spawnSync(python, ['-I', '-B', path.join(__dirname, '../../../scripts/serena-processes.py')], {
    input: JSON.stringify({ command: 'inspect', owner: createOwner(), callerPid: process.pid + 1000000 }),
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(wrongCaller.status, 1);
  assert.deepEqual(JSON.parse(wrongCaller.stdout), { ok: false, error_type: 'RuntimeError' });
  if (process.platform === 'win32') {
    console.log('serena_processes.test.js PASS: identity probe; POSIX cleanup skipped');
    return;
  }
  await assert.rejects(inspectIdentities('/bin/echo', []), /^Error: Serena process helper failed$/);
  execFileSync(python, ['-I', '-B', path.join(__dirname, 'test_serena_processes.py')], { stdio: 'inherit' });
  assert.throws(() => inspectOwned(python, 'bad-token'), /Invalid Serena process owner/);
  await assert.rejects(cleanupOwned(python, ''), /Invalid Serena process owner/);

  const owner = createOwner();
  const otherOwner = createOwner();
  const owners = [owner, otherOwner];
  assert.notEqual(owner, otherOwner);
  let stage = 'early-launch';
  let primaryError = null;
  try {
    const early = launch('early', 'stubborn', owner);
    const earlyPid = await early.childPid;
    assert.equal(await waitForExit(early.root), 0, 'root exits before its independent-session LSP');
    stage = 'other-launch';
    const other = launch('live', 'stubborn', otherOwner);
    const otherPid = await other.childPid;
    stage = 'early-inspect';
    const owned = await eventually(() => inspectOwned(python, owner),
      (found) => found.some((item) => item.pid === earlyPid));
    assert.ok(owned.every((item) => item.uid === process.getuid()));
    const childIdentity = owned.find((item) => item.pid === earlyPid);
    assert.deepEqual(await inspectIdentities(python, [childIdentity]), [childIdentity]);
    assert.deepEqual(await inspectIdentities(python, [{ ...childIdentity, create_time: childIdentity.create_time + 1 }]), []);
    stage = 'other-inspect';
    assert.ok((await inspectOwned(python, otherOwner)).some((item) => item.pid === otherPid));
    stage = 'early-cleanup';
    await cleanupOwned(python, owner, opts);
    stage = 'early-verify';
    assert.deepEqual(await inspectOwned(python, owner), [], 'orphaned independent-session LSP must be gone');
    assert.deepEqual(await inspectIdentities(python, [childIdentity]), []);
    assert.ok((await inspectOwned(python, otherOwner)).some((item) => item.pid === otherPid), 'another owner must survive');

    stage = 'eof-launch';
    const eofOwner = createOwner();
    owners.push(eofOwner);
    const eofTree = launch('eof', 'delayed', eofOwner);
    eofTree.root.stdin.end();
    const eofPid = await eofTree.childPid;
    assert.equal(await waitForExit(eofTree.root), 0, 'root exits after spawning on EOF');
    stage = 'eof-inspect';
    await eventually(() => inspectOwned(python, eofOwner), (found) => found.some((item) => item.pid === eofPid));
    stage = 'eof-cleanup';
    await cleanupOwned(python, eofOwner, opts);
    stage = 'eof-verify';
    assert.deepEqual(await inspectOwned(python, eofOwner), [], 'LSP spawned during EOF must be gone');

    stage = 'live-launch';
    const liveOwner = createOwner();
    owners.push(liveOwner);
    const liveTree = launch('live', 'stubborn', liveOwner);
    const livePid = await liveTree.childPid;
    stage = 'live-inspect';
    await eventually(() => inspectOwned(python, liveOwner),
      (found) => found.some((item) => item.pid === livePid)
        && found.some((item) => item.pid === liveTree.root.pid));
    liveTree.root.stdin.end();
    await wait(100);
    assert.equal(liveTree.root.exitCode, null, 'live root rejects stdin EOF');
    assert.ok((await inspectOwned(python, liveOwner)).some((item) => item.pid === liveTree.root.pid));
    stage = 'live-cleanup';
    await cleanupOwned(python, liveOwner, opts);
    stage = 'live-verify';
    assert.deepEqual(await inspectOwned(python, liveOwner), [], 'live root and independent-session LSP must both be gone');

    stage = 'term-launch';
    const termOwner = createOwner();
    owners.push(termOwner);
    const termTree = launch('term_spawn', 'stubborn', termOwner);
    const firstPid = await termTree.childPid;
    stage = 'term-cleanup';
    const [latePid] = await Promise.all([termTree.nextPid(), cleanupOwned(python, termOwner, opts)]);
    assert.notEqual(latePid, firstPid, 'SIGTERM handler spawned a new independent-session LSP');
    assert.equal(await waitForExit(termTree.root), 0, 'root exits after SIGTERM handler');
    stage = 'term-verify';
    assert.deepEqual(await inspectOwned(python, termOwner), [], 'repeated scan removes LSP spawned during cleanup');
  } catch (error) {
    primaryError = error;
  } finally {
    await finishOwned(owners, (ownedBy) => cleanupOwned(python, ownedBy, opts),
      async () => assert.deepEqual(await inspectOwned(python, otherOwner), []), primaryError, stage);
  }
  console.log('serena_processes.test.js PASS');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
