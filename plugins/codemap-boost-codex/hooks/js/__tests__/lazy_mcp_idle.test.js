'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { LazyMcpProxy, IDLE_TIMEOUT_MS, killProcessTree } = require('../../../scripts/lazy-mcp.cjs');
const { prepareMcpServerAsync } = require('../../../scripts/mcp-server.cjs');

const catalog = { protocolVersion: '2025-11-25', serverInfo: { name: 'idle-fixture', version: '1' }, capabilities: {},
  tools: [], prompts: [], resources: [], resourceTemplates: [], requestMethods: ['tools/call', 'logging/setLevel'] };
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await turn(); }
  assert.fail('expected observable state did not arrive');
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fakeClock() {
  let time = 0, sequence = 0;
  const timers = new Map();
  return { now: () => time,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, deadline: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(amount) {
      time += amount;
      for (;;) {
        const entry = [...timers].find(([, timer]) => timer.deadline <= time);
        if (!entry) break;
        timers.delete(entry[0]); entry[1].fn(); await turn();
      }
      await turn();
    },
  };
}
function backend({ automatic = true, handshake = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  const messages = [];
  const send = (message) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const exit = (code = 0) => { child.exitCode = code; child.emit('exit', code); };
  child.stdin.on('data', (chunk) => {
    for (const line of String(chunk).trim().split('\n')) {
      const message = JSON.parse(line); messages.push(message);
      if (message.method === 'initialize' && handshake) send({ id: message.id, result: catalog });
      if (message.method === 'logging/setLevel') send({ id: message.id, result: {} });
      if (message.method === 'tools/call' && automatic) send({ id: message.id, result: { content: [] } });
    }
  });
  return { child, messages, send, exit };
}
function fixture(options = {}) {
  const input = new PassThrough(), output = new PassThrough(), stderr = new PassThrough();
  const received = [], backends = [], kills = [], clock = fakeClock();
  let diagnostics = '';
  stderr.on('data', (chunk) => { diagnostics += chunk; });
  output.on('data', (chunk) => { for (const line of String(chunk).trim().split('\n')) received.push(JSON.parse(line)); });
  const launchBackend = options.launchBackend || (async () => { const b = backend(options.backendOptions); backends.push(b); return b.child; });
  const killTree = options.killTree || (async (child) => { kills.push(child); backends.find((b) => b.child === child).exit(); });
  const proxy = new LazyMcpProxy({ input, output, stderr, catalog: async () => catalog, launchBackend,
    idleTimeoutMs: 100, clock, startupTimeoutMs: 1000, killTree, ...options });
  const completion = proxy.run();
  const send = (message) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const response = async (id) => { await until(() => received.some((message) => message.id === id)); return received.find((message) => message.id === id); };
  const call = (id) => send({ id, method: 'tools/call', params: { name: 'fixture' } });
  const close = async () => { input.end(); await completion; };
  return { proxy, received, backends, kills, clock, send, response, call, close, diagnostics: () => diagnostics };
}

async function main() {
  const f = fixture();
  try {
    for (const [id, method] of [[1, 'initialize'], [2, 'tools/list'], [3, 'ping']]) { f.send({ id, method }); await f.response(id); }
    await f.clock.advance(1000); assert.equal(f.backends.length, 0, 'discovery does not launch backend');
    f.call(4); await f.response(4);
    await f.clock.advance(99); assert.equal(f.kills.length, 0);
    await f.clock.advance(1); assert.equal(f.kills.length, 1, 'idle deadline reclaims backend tree');
    assert.equal(IDLE_TIMEOUT_MS, 600000, 'production defaults to a real ten minutes');
    assert.equal(f.proxy.closed, false);
    for (const [id, method] of [[5, 'ping'], [6, 'tools/list']]) { f.send({ id, method }); await f.response(id); }
    assert.equal(f.backends.length, 1, 'discovery after reclaim does not restart');
  } finally { await f.close(); }

  const production = fixture({ idleTimeoutMs: undefined });
  try {
    production.call(1); await production.response(1);
    await production.clock.advance(599999); assert.equal(production.kills.length, 0);
    await production.clock.advance(1); assert.equal(production.kills.length, 1, 'default timer uses the full ten minutes');
  } finally { await production.close(); }

  const busy = fixture({ backendOptions: { automatic: false } });
  try {
    busy.call(1); await until(() => busy.backends[0] && busy.backends[0].messages.some((m) => m.method === 'tools/call'));
    await busy.clock.advance(1000); assert.equal(busy.kills.length, 0, 'active call crosses idle deadline safely');
    const call = busy.backends[0].messages.find((m) => m.method === 'tools/call');
    busy.backends[0].send({ id: call.id, result: {} }); await busy.response(1);
    await busy.clock.advance(99); assert.equal(busy.kills.length, 0);
    busy.send({ id: 2, method: 'ping' }); await busy.response(2);
    busy.send({ id: 3, method: 'tools/list' }); await busy.response(3);
    await busy.clock.advance(1); assert.equal(busy.kills.length, 1, 'discovery does not extend last-completion deadline');
  } finally { await busy.close(); }

  const deadline = fixture({ backendOptions: { automatic: false } });
  try {
    deadline.call(1); await until(() => deadline.proxy.ready && deadline.proxy.pending.size === 1);
    deadline.backends[0].send({ id: [...deadline.proxy.pending.keys()][0], result: {} }); await deadline.response(1);
    await deadline.clock.advance(99);
    deadline.call(2); await until(() => deadline.proxy.pending.size === 1);
    await deadline.clock.advance(1000); assert.equal(deadline.kills.length, 0, 'new request before retirement invalidates old idle deadline');
    deadline.backends[0].send({ id: [...deadline.proxy.pending.keys()][0], result: {} }); await deadline.response(2);
    await deadline.clock.advance(100); assert.equal(deadline.kills.length, 1);
  } finally { await deadline.close(); }

  const preparing = deferred(), prepared = backend();
  let prepareStarts = 0, prepareKills = 0;
  const prepare = fixture({ launchBackend: () => { prepareStarts++; return preparing.promise; },
    killTree: async () => { prepareKills++; prepared.exit(); } });
  try {
    prepare.call(1); await until(() => prepareStarts === 1);
    await prepare.clock.advance(1000); assert.equal(prepareKills, 0, 'preparation is never idle');
    preparing.resolve(prepared.child); await prepare.response(1);
    await prepare.clock.advance(100); assert.equal(prepareKills, 1);
  } finally { await prepare.close(); }

  const handshake = fixture({ backendOptions: { handshake: false } });
  try {
    handshake.call(1); await until(() => handshake.backends[0] && handshake.backends[0].messages.length);
    await handshake.clock.advance(1000); assert.equal(handshake.kills.length, 0, 'initialize handshake is never idle');
    const init = handshake.backends[0].messages[0];
    handshake.backends[0].send({ id: init.id, result: catalog }); await handshake.response(1);
    await handshake.clock.advance(100); assert.equal(handshake.kills.length, 1);
  } finally { await handshake.close(); }

  const cancelled = fixture({ backendOptions: { automatic: false } });
  try {
    cancelled.call(1); await until(() => cancelled.backends[0] && cancelled.backends[0].messages.some((m) => m.method === 'tools/call'));
    const b = cancelled.backends[0], first = b.messages.find((m) => m.method === 'tools/call');
    cancelled.send({ method: 'notifications/cancelled', params: { requestId: 1 } }); await turn();
    await cancelled.clock.advance(1000); assert.equal(cancelled.kills.length, 0, 'forwarded cancellation is not a completion acknowledgement');
    assert.equal(cancelled.proxy.pending.size, 1);
    // The host may reuse an ID after cancellation; an old response must not clear the new request.
    cancelled.call(1); await until(() => b.messages.filter((m) => m.method === 'tools/call').length === 2);
    b.send({ id: first.id, result: {} }); await turn();
    assert.equal(cancelled.received.some((m) => m.id === 1), false);
    assert.equal(cancelled.proxy.hostRequests.size, 1);
    await cancelled.clock.advance(1000); assert.equal(cancelled.kills.length, 0);
    b.send({ id: b.messages.filter((m) => m.method === 'tools/call')[1].id, result: {} }); await cancelled.response(1);
    await cancelled.clock.advance(99); assert.equal(cancelled.kills.length, 0);
    await cancelled.clock.advance(1); assert.equal(cancelled.kills.length, 1);
  } finally { await cancelled.close(); }

  const callback = fixture();
  try {
    callback.call(1); await callback.response(1);
    const b = callback.backends[0]; b.send({ id: 'callback', method: 'roots/list' });
    await until(() => callback.received.some((m) => m.method === 'roots/list'));
    await callback.clock.advance(1000); assert.equal(callback.kills.length, 0, 'backend callback waits are busy even without a host call');
    const cb = callback.received.find((m) => m.method === 'roots/list');
    callback.send({ id: cb.id, result: { roots: [] } }); await turn();
    assert.equal(b.messages.at(-1).id, 'callback');
    await callback.clock.advance(99); assert.equal(callback.kills.length, 0);
    await callback.clock.advance(1); assert.equal(callback.kills.length, 1);
  } finally { await callback.close(); }

  let finishRetire, retireKills = 0;
  const race = fixture({ killTree: async (child) => {
    retireKills++;
    if (retireKills === 1) await new Promise((resolve) => { finishRetire = () => { child.exitCode = 0; child.emit('exit', 0); resolve(); }; });
    else { child.exitCode = 0; child.emit('exit', 0); }
  } });
  try {
    race.send({ id: 'init', method: 'initialize', params: { protocolVersion: catalog.protocolVersion, capabilities: { sampling: {} }, clientInfo: { name: 'host', version: '1' } } }); await race.response('init');
    race.send({ id: 'level', method: 'logging/setLevel', params: { level: 'warning' } }); await race.response('level');
    race.call(1); await race.response(1);
    await race.clock.advance(100); assert.equal(race.proxy.state, 'retiring');
    race.send({ id: 'new-level', method: 'logging/setLevel', params: { level: 'debug' } }); await race.response('new-level');
    race.call(2); race.call(3); await turn();
    race.send({ id: 'ping', method: 'ping' }); await race.response('ping');
    assert.equal(race.backends.length, 1, 'request racing retirement waits for old child termination');
    await race.clock.advance(1000); assert.equal(retireKills, 1, 'tree termination is invoked once');
    finishRetire(); await Promise.all([race.response(2), race.response(3)]);
    assert.equal(race.backends.length, 2, 'concurrent restart shares one backend');
    const restarted = race.backends[1];
    assert.deepEqual(restarted.messages.find((m) => m.method === 'initialize').params.capabilities, { sampling: {} });
    assert.equal(restarted.messages.filter((m) => m.method === 'notifications/initialized').length, 1);
    assert.equal(restarted.messages.find((m) => m.method === 'logging/setLevel').params.level, 'debug', 'configuration updated during retirement is replayed');
    assert.ok(restarted.messages.findIndex((m) => m.method === 'logging/setLevel') < restarted.messages.findIndex((m) => m.method === 'tools/call'));
    restarted.child.stdin.removeAllListeners('data');
    race.call(4); await until(() => race.proxy.pending.size === 1);
    const current = race.proxy.child;
    race.backends[0].child.emit('exit', 9); race.backends[0].child.emit('error', new Error('late old error')); await turn();
    assert.equal(race.proxy.child, current); assert.equal(race.proxy.pending.size, 1, 'old-generation events cannot fail new requests');
    restarted.send({ id: [...race.proxy.pending.keys()][0], result: {} }); await race.response(4);
  } finally { await race.close(); }

  let unconfirmedKills = 0;
  const unconfirmed = fixture({ killTree: async () => { unconfirmedKills++; } });
  unconfirmed.call(1); await unconfirmed.response(1);
  await unconfirmed.clock.advance(100); assert.equal(unconfirmed.proxy.state, 'retiring');
  unconfirmed.call(2); await turn();
  assert.equal(unconfirmed.backends.length, 1, 'resolved kill command without child exit does not permit restart');
  unconfirmed.backends[0].exit(); await unconfirmed.response(2);
  unconfirmed.backends[1].exit(); await unconfirmed.close(); assert.equal(unconfirmedKills, 1);

  let rejectKill = true, failedKills = 0;
  const failedKill = fixture({ killTree: async (child) => {
    failedKills++;
    if (rejectKill) throw new Error('fixture cannot stop tree');
    child.exitCode = 0; child.emit('exit', 0);
  } });
  try {
    failedKill.call(1); await failedKill.response(1); await failedKill.clock.advance(100);
    assert.equal(failedKill.proxy.state, 'ready');
    assert.match(failedKill.diagnostics(), /termination failed/); assert.doesNotMatch(failedKill.diagnostics(), /idle stopped/);
    failedKill.call(2); await failedKill.response(2); assert.equal(failedKill.backends.length, 1, 'failed termination retains original backend');
    rejectKill = false; await failedKill.clock.advance(100); assert.equal(failedKills, 2); assert.equal(failedKill.proxy.state, 'cold');
  } finally { rejectKill = false; await failedKill.close(); }

  const failedRetirement = deferred(); let recoveryKills = 0;
  const recovery = fixture({ killTree: async (child) => {
    if (++recoveryKills === 1) return failedRetirement.promise;
    child.exitCode = 0; child.emit('exit', 0);
  } });
  try {
    recovery.send({ id: 'level', method: 'logging/setLevel', params: { level: 'warning' } }); await recovery.response('level');
    recovery.call(1); await recovery.response(1); await recovery.clock.advance(100);
    recovery.send({ id: 'new-level', method: 'logging/setLevel', params: { level: 'debug' } }); await recovery.response('new-level');
    recovery.send({ method: 'notifications/roots/list_changed' }); await turn();
    const b = recovery.backends[0];
    b.child.stdin.removeAllListeners('data');
    b.child.stdin.on('data', (chunk) => {
      const m = JSON.parse(String(chunk)); b.messages.push(m);
      if (m.method === 'tools/call') b.send({ id: m.id, result: {} });
    });
    recovery.call(2);
    failedRetirement.reject(new Error('fixture retained tree'));
    await until(() => b.messages.some((m) => m.method === 'logging/setLevel' && m.params.level === 'debug'));
    assert.equal(recovery.proxy.state, 'recovering'); assert.equal(recovery.proxy.ready, false);
    assert.equal(b.messages.filter((m) => m.method === 'tools/call').length, 1, 'actual requests wait for replay acknowledgement');
    recovery.send({ id: 'latest-level', method: 'logging/setLevel', params: { level: 'error' } }); await recovery.response('latest-level');
    b.send({ id: b.messages.find((m) => m.method === 'logging/setLevel' && m.params.level === 'debug').id, result: {} });
    await until(() => b.messages.some((m) => m.method === 'logging/setLevel' && m.params.level === 'error'));
    assert.equal(b.messages.filter((m) => m.method === 'tools/call').length, 1);
    b.send({ id: b.messages.find((m) => m.method === 'logging/setLevel' && m.params.level === 'error').id, result: {} });
    await recovery.response(2);
    const methods = b.messages.map((m) => m.method);
    assert.deepEqual(b.messages.filter((m) => m.method === 'logging/setLevel').map((m) => m.params.level), ['warning', 'debug', 'error'], 'failed retirement replays latest cached logging state, including changes during recovery');
    assert.equal(recovery.proxy.notifications.length, 0, 'failed retirement drains queued notifications');
    assert.ok(methods.lastIndexOf('logging/setLevel') < methods.lastIndexOf('tools/call'));
    assert.ok(methods.indexOf('notifications/roots/list_changed') < methods.lastIndexOf('tools/call'), 'retained backend receives queued notifications before subsequent tool');
    assert.equal(recovery.backends.length, 1);
  } finally { failedRetirement.reject(new Error('cleanup')); await recovery.close(); }

  const microtaskRetirement = deferred(); let microtaskKills = 0;
  const microtaskRecovery = fixture({ killTree: async (child) => {
    if (++microtaskKills === 1) return microtaskRetirement.promise;
    child.exitCode = 0; child.emit('exit', 0);
  } });
  try {
    microtaskRecovery.call(1); await microtaskRecovery.response(1); await microtaskRecovery.clock.advance(100);
    microtaskRecovery.send({ id: 'level', method: 'logging/setLevel', params: { level: 'debug' } }); await microtaskRecovery.response('level');
    const b = microtaskRecovery.backends[0]; b.child.stdin.removeAllListeners('data');
    b.child.stdin.on('data', (chunk) => {
      const m = JSON.parse(String(chunk)); b.messages.push(m);
      if (m.method === 'logging/setLevel') {
        b.send({ id: m.id, result: {} });
        if (m.params.level === 'debug') microtaskRecovery.send({ id: 'latest-level', method: 'logging/setLevel', params: { level: 'error' } });
      }
      if (m.method === 'tools/call') b.send({ id: m.id, result: {} });
    });
    microtaskRetirement.reject(new Error('fixture microtask stop failed'));
    await microtaskRecovery.response('latest-level'); await until(() => microtaskRecovery.proxy.state === 'ready');
    microtaskRecovery.call(2); await microtaskRecovery.response(2);
    assert.deepEqual(b.messages.filter((m) => m.method === 'logging/setLevel').map((m) => m.params.level), ['debug', 'error'], 'configuration arriving between replay completion and readiness must reach retained backend');
  } finally { microtaskRetirement.reject(new Error('cleanup')); await microtaskRecovery.close(); }

  const queuedRetirement = deferred(); let queuedKills = 0;
  const queuedRecovery = fixture({ killTree: async (child) => {
    if (++queuedKills === 1) return queuedRetirement.promise;
    child.exitCode = 0; child.emit('exit', 0);
  } });
  try {
    queuedRecovery.call(1); await queuedRecovery.response(1); await queuedRecovery.clock.advance(100);
    queuedRecovery.send({ id: 'level', method: 'logging/setLevel', params: { level: 'debug' } }); await queuedRecovery.response('level');
    const b = queuedRecovery.backends[0]; b.child.stdin.removeAllListeners('data');
    b.child.stdin.on('data', (chunk) => {
      const m = JSON.parse(String(chunk)); b.messages.push(m);
      if (m.method === 'tools/call' || (m.method === 'logging/setLevel' && m.params.level === 'error')) b.send({ id: m.id, result: {} });
    });
    queuedRecovery.call(2); queuedRetirement.reject(new Error('fixture queued stop failed'));
    await until(() => b.messages.some((m) => m.method === 'logging/setLevel'));
    const replay = b.messages.find((m) => m.method === 'logging/setLevel');
    // The backend response wakes replay before the host request enters the cached-catalog await microtask queue.
    b.send({ id: replay.id, result: {} });
    queuedRecovery.send({ id: 'latest-level', method: 'logging/setLevel', params: { level: 'error' } });
    queuedRecovery.send({ method: 'notifications/roots/list_changed' });
    await Promise.all([queuedRecovery.response(2), queuedRecovery.response('latest-level')]);
    assert.deepEqual(b.messages.filter((m) => m.method === 'logging/setLevel').map((m) => m.params.level), ['debug', 'error'], 'retained backend receives logging request queued after replay acknowledgement');
    assert.equal(queuedRecovery.proxy.loggingLevel, 'error'); assert.equal(queuedRecovery.proxy.ready, true);
    assert.equal(queuedRecovery.proxy.notifications.length, 0); assert.equal(queuedRecovery.backends.length, 1);
    const methods = b.messages.map((m) => m.method);
    assert.ok(methods.indexOf('notifications/roots/list_changed') < methods.lastIndexOf('tools/call'), 'retained backend flushes queued notification before waiting operation');
  } finally { queuedRetirement.reject(new Error('cleanup')); await queuedRecovery.close(); }

  const failedEofRetirement = deferred(); let recoveryEofKills = 0;
  const recoveryEof = fixture({ killTree: async (child) => {
    if (++recoveryEofKills === 1) return failedEofRetirement.promise;
    child.exitCode = 0; child.emit('exit', 0);
  } });
  recoveryEof.call(1); await recoveryEof.response(1); await recoveryEof.clock.advance(100);
  recoveryEof.send({ id: 'level', method: 'logging/setLevel', params: { level: 'debug' } }); await recoveryEof.response('level');
  recoveryEof.backends[0].child.stdin.removeAllListeners('data');
  failedEofRetirement.reject(new Error('fixture stop failed before EOF'));
  await until(() => recoveryEof.proxy.state === 'recovering' && recoveryEof.proxy.pending.size === 1);
  await recoveryEof.close();
  assert.equal(recoveryEofKills, 2, 'EOF during recovery retries cleanup of retained process');
  assert.equal(recoveryEof.proxy.child, null); assert.equal(recoveryEof.proxy.ready, false);

  const failedReplayRetirement = deferred(); let failedReplayKills = 0;
  const failedReplay = fixture({ killTree: async (child) => {
    if (++failedReplayKills === 1) return failedReplayRetirement.promise;
    child.exitCode = 0; child.emit('exit', 0);
  } });
  try {
    failedReplay.call(1); await failedReplay.response(1); await failedReplay.clock.advance(100);
    failedReplay.send({ id: 'level', method: 'logging/setLevel', params: { level: 'debug' } }); await failedReplay.response('level');
    const b = failedReplay.backends[0]; b.child.stdin.removeAllListeners('data');
    b.child.stdin.on('data', (chunk) => {
      const m = JSON.parse(String(chunk)); b.messages.push(m);
      if (m.method === 'logging/setLevel') b.send({ id: m.id, error: { code: -32603, message: 'fixture replay rejected' } });
    });
    failedReplay.call(2); failedReplayRetirement.reject(new Error('fixture cannot retire'));
    assert.match((await failedReplay.response(2)).error.message, /replay rejected/);
    assert.equal(failedReplay.proxy.state, 'failed'); assert.equal(failedReplay.proxy.ready, false);
    assert.equal(b.messages.filter((m) => m.method === 'tools/call').length, 1, 'replay failure cannot accept waiting tool');
    assert.equal(failedReplay.backends.length, 1);
    failedReplay.call(3); await failedReplay.response(3);
    assert.equal(failedReplayKills, 2); assert.equal(failedReplay.backends.length, 2, 'retry disposes retained backend before starting replacement');
    assert.equal(failedReplay.backends[1].messages.find((m) => m.method === 'logging/setLevel').params.level, 'debug');
  } finally { failedReplayRetirement.reject(new Error('cleanup')); await failedReplay.close(); }

  const notificationFailureChild = backend(); let notificationFailureKills = 0;
  notificationFailureChild.child.stdin.removeAllListeners('data');
  notificationFailureChild.child.stdin.on('data', (chunk) => {
    const m = JSON.parse(String(chunk)); notificationFailureChild.messages.push(m);
    if (m.method === 'initialize') notificationFailureChild.send({ id: m.id, result: catalog });
    if (m.method === 'notifications/roots/list_changed') notificationFailureChild.child.stdin.emit('error', new Error('fixture notification write failed'));
    if (m.method === 'tools/call') notificationFailureChild.send({ id: m.id, result: {} });
  });
  const startupNotificationFailure = fixture({ launchBackend: async () => notificationFailureChild.child,
    killTree: async () => { notificationFailureKills++; notificationFailureChild.exit(); } });
  try {
    startupNotificationFailure.send({ method: 'notifications/roots/list_changed' });
    startupNotificationFailure.call(1);
    const reply = await startupNotificationFailure.response(1);
    assert.ok(reply.error, 'notification stream failure during startup replay must not be overwritten by ready=true');
    assert.equal(notificationFailureChild.messages.filter((m) => m.method === 'tools/call').length, 0);
    assert.equal(startupNotificationFailure.proxy.ready, false); assert.equal(notificationFailureKills, 1);
  } finally { await startupNotificationFailure.close(); }

  const lateNotificationFailureChild = backend(); let lateNotificationFailureKills = 0;
  lateNotificationFailureChild.child.stdin.removeAllListeners('data');
  lateNotificationFailureChild.child.stdin.on('data', (chunk) => {
    const m = JSON.parse(String(chunk)); lateNotificationFailureChild.messages.push(m);
    if (m.method === 'initialize') lateNotificationFailureChild.send({ id: m.id, result: catalog });
    // The helper has synchronously flushed and published ready; the error microtask arrives before the outer await continuation.
    if (m.method === 'notifications/roots/list_changed') queueMicrotask(() => lateNotificationFailureChild.child.stdin.emit('error', new Error('fixture late notification write failed')));
    if (m.method === 'tools/call') lateNotificationFailureChild.send({ id: m.id, result: {} });
  });
  const startupLateNotificationFailure = fixture({ launchBackend: async () => lateNotificationFailureChild.child,
    killTree: async () => { lateNotificationFailureKills++; lateNotificationFailureChild.exit(); } });
  try {
    startupLateNotificationFailure.send({ method: 'notifications/roots/list_changed' });
    startupLateNotificationFailure.call(1);
    const reply = await startupLateNotificationFailure.response(1);
    assert.ok(reply.error, 'backend error after ready publication but before launch resumes must fail startup');
    assert.equal(lateNotificationFailureChild.messages.filter((m) => m.method === 'tools/call').length, 0);
    assert.equal(lateNotificationFailureKills, 1, 'post-replay backend failure must reap the starting backend');
    assert.equal(startupLateNotificationFailure.proxy.ready, false); assert.equal(startupLateNotificationFailure.proxy.child, null);
    assert.equal(startupLateNotificationFailure.proxy.state, 'cold');
  } finally { await startupLateNotificationFailure.close(); }

  const failure = fixture({ backendOptions: { automatic: false } });
  try {
    failure.call(1); await until(() => failure.proxy.pending.size === 1 && failure.proxy.ready);
    failure.backends[0].exit(9); assert.match((await failure.response(1)).error.message, /exited/);
    failure.call(2); await until(() => failure.backends.length === 2 && failure.proxy.ready);
    failure.backends[1].send({ id: [...failure.proxy.pending.keys()][0], result: {} }); await failure.response(2);
    assert.equal(failure.kills.length, 0, 'already-exited children are never tree-killed');
  } finally { await failure.close(); }

  let attempts = 0;
  const recovered = backend();
  const retry = fixture({ launchBackend: async () => { if (++attempts === 1) throw new Error('prepare failed'); return recovered.child; },
    killTree: async () => recovered.exit() });
  try {
    retry.call(1); assert.match((await retry.response(1)).error.message, /prepare failed/);
    retry.call(2); await retry.response(2); assert.equal(attempts, 2);
  } finally { await retry.close(); }

  const timedPrepare = deferred(), timedChild = backend(), afterTimeout = backend();
  let timedStarts = 0, timedKills = 0, prepareAborted = false;
  const cancelledPrepare = fixture({ startupTimeoutMs: 20, launchBackend: (signal) => {
    if (++timedStarts === 1) {
      signal.addEventListener('abort', () => { prepareAborted = true; }, { once: true });
      return timedPrepare.promise;
    }
    return afterTimeout.child;
  }, killTree: async (child) => { timedKills++; child.exitCode = 0; child.emit('exit', 0); } });
  try {
    cancelledPrepare.call(1);
    await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(prepareAborted, true);
    cancelledPrepare.call(2); await turn();
    assert.equal(timedStarts, 1, 'timed-out preparation without exit confirmation cannot overlap a retry');
    assert.equal(cancelledPrepare.received.some((m) => m.id === 1), false, 'uncertain preparation remains occupied');
    timedPrepare.resolve(timedChild.child);
    assert.match((await cancelledPrepare.response(1)).error.message, /timeout/);
    assert.match((await cancelledPrepare.response(2)).error.message, /timeout/);
    assert.equal(timedKills, 1);
    cancelledPrepare.call(3); await cancelledPrepare.response(3); assert.equal(timedStarts, 2);
  } finally { timedPrepare.resolve(timedChild.child); await cancelledPrepare.close(); }

  const latePrepare = deferred(), lateChild = backend(); let lateKills = 0, enteredPrepare = false;
  const eofPrepare = fixture({ launchBackend: () => { enteredPrepare = true; return latePrepare.promise; },
    killTree: async () => { lateKills++; lateChild.exit(); } });
  eofPrepare.call(1); await until(() => enteredPrepare); await eofPrepare.close();
  latePrepare.resolve(lateChild.child); await until(() => lateKills === 1);
  assert.equal(eofPrepare.proxy.child, null, 'EOF during preparation cleans a child returned late');

  const eofStarting = fixture({ backendOptions: { handshake: false } });
  eofStarting.call(1); await until(() => eofStarting.proxy.child); await eofStarting.close();
  assert.equal(eofStarting.kills.length, 1); assert.equal(eofStarting.proxy.child, null, 'EOF during initialize leaves no child');

  let releaseEofKill, eofKills = 0;
  const eofRetire = fixture({ killTree: async (child) => { eofKills++; await new Promise((resolve) => { releaseEofKill = () => { child.exitCode = 0; child.emit('exit', 0); resolve(); }; }); } });
  eofRetire.call(1); await eofRetire.response(1); await eofRetire.clock.advance(100);
  const closing = eofRetire.close(); await turn(); releaseEofKill(); await closing;
  assert.equal(eofKills, 1); assert.equal(eofRetire.proxy.child, null, 'EOF joins ongoing retirement');

  // Never use an exited PID to terminate a tree, including after signal exit.
  await killProcessTree({ exitCode: 0, pid: 99999999, kill() { assert.fail('must not kill exited process'); } });
  await killProcessTree({ exitCode: null, signalCode: 'SIGTERM', pid: 99999999, kill() { assert.fail('must not kill exited process'); } });

  const prepareProcess = backend(), abortPrepare = new AbortController();
  prepareProcess.child.kill = () => false;
  let prepareDiagnostics = '', prepareSettled = false;
  const prepareErrorOutput = new PassThrough(); prepareErrorOutput.on('data', (chunk) => { prepareDiagnostics += chunk; });
  const prepareOperation = prepareMcpServerAsync({
    pluginDataDir: path.join(os.tmpdir(), 'codemap-idle-prepare-fixture'),
    prepareSpawn: () => prepareProcess.child, stderr: prepareErrorOutput,
  }, abortPrepare.signal);
  prepareOperation.then(() => { prepareSettled = true; }, () => { prepareSettled = true; });
  abortPrepare.abort(); await until(() => /termination failed/.test(prepareDiagnostics));
  assert.equal(prepareSettled, false, 'prepare kill failure retains launch occupancy without unhandled rejection');
  prepareProcess.child.exitCode = 0; prepareProcess.child.emit('close', 0);
  await assert.rejects(prepareOperation, /preparation cancelled/);
  console.log('lazy_mcp_idle.test.js PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
