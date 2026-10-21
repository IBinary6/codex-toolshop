'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { LazyMcpProxy } = require('../../../scripts/lazy-mcp.cjs');

const catalog = {
  version: '2.3.9', protocolVersion: '2025-11-25', serverInfo: { name: 'fixture', version: '2.3.9' },
  capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: {} },
  tools: [{ name: 'example', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, outputSchema: { type: 'object' } }],
  prompts: [{ name: 'review', arguments: [{ name: 'base', required: false }] }], resources: [], resourceTemplates: [],
  requestMethods: ['tools/call', 'prompts/get', 'resources/read', 'logging/setLevel'],
};
function fixture(launchBackend, options = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const received = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      received.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1);
    }
  });
  const proxy = new LazyMcpProxy({ input, output, catalog: async () => catalog, launchBackend, startupTimeoutMs: 500, progressIntervalMs: 10, killTree: async (child) => child.emit('exit', 0), ...options });
  const completion = proxy.run();
  const send = (message) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const response = async (id) => {
    const deadline = Date.now() + 2000;
    while (!received.find((message) => message.id === id)) {
      if (Date.now() > deadline) throw new Error(`missing response ${id}: ${JSON.stringify(received)}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return received.find((message) => message.id === id);
  };
  return { proxy, input, received, completion, send, response };
}
function backend() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  const messages = [];
  child.stdin.on('data', (chunk) => {
    for (const line of String(chunk).trim().split('\n')) {
      const message = JSON.parse(line); messages.push(message);
      if (message.method === 'initialize') child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ...catalog } })}\n`);
      if (message.method === 'tools/call') child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'called' }] } })}\n`);
      if (message.method === 'logging/setLevel') child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
    }
  });
  return { child, messages };
}
async function main() {
  // A host that skips PreToolUse must still be unable to read an unprepared graph.
  {
    let starts = 0;
    const guarded = fixture(async () => { starts++; return backend().child; }, {
      prepareToolCall: async () => { throw new Error('graph refresh failed'); },
    });
    guarded.send({ id: 'blocked', method: 'tools/call', params: { name: 'example' } });
    assert.match((await guarded.response('blocked')).error.message, /graph refresh failed/);
    assert.equal(starts, 0, 'failed preparation must not reach the backend');
    guarded.input.end(); await guarded.completion;
  }
  {
    const b = backend();
    const guarded = fixture(async () => b.child, {
      prepareToolCall: async (params) => ({ ...params, arguments: { repo_root: '/canonical/repo' } }),
    });
    guarded.send({ id: 'canonical', method: 'tools/call', params: { name: 'example' } });
    await guarded.response('canonical');
    assert.equal(b.messages.find((m) => m.method === 'tools/call').params.arguments.repo_root, '/canonical/repo');
    guarded.input.end(); await guarded.completion;
  }
  let starts = 0;
  const b = backend();
  const f = fixture(async () => { starts++; await new Promise((resolve) => setTimeout(resolve, 30)); return b.child; });
  f.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { sampling: {} }, clientInfo: { name: 'host', version: '1' } } });
  assert.equal((await f.response(1)).result.serverInfo.name, 'fixture');
  f.send({ id: 'logging', method: 'logging/setLevel', params: { level: 'warning' } });
  assert.deepEqual((await f.response('logging')).result, {});
  assert.equal(starts, 0, 'logging configuration before discovery must not start backend');
  f.send({ id: 'bad-logging', method: 'logging/setLevel', params: { level: 'verbose' } });
  assert.equal((await f.response('bad-logging')).error.code, -32602);
  assert.equal(starts, 0, 'invalid logging configuration must not start backend');
  for (const [id, method] of [[2, 'tools/list'], [3, 'prompts/list'], [4, 'resources/list'], [5, 'resources/templates/list'], [6, 'ping']]) f.send({ id, method });
  assert.deepEqual((await f.response(2)).result.tools, catalog.tools);
  assert.deepEqual((await f.response(3)).result.prompts, catalog.prompts);
  await f.response(6); assert.equal(starts, 0, 'discovery must not start backend');
  f.send({ id: 7, method: 'unknown/method' });
  assert.equal((await f.response(7)).error.code, -32601);
  assert.equal(starts, 0, 'unknown RPC must not start backend');
  f.send({ method: 'notifications/initialized' });
  f.send({ id: 10, method: 'tools/call', params: { name: 'example', _meta: { progressToken: 'cold' } } });
  f.send({ id: '10', method: 'tools/call', params: { name: 'example' } });
  await Promise.all([f.response(10), f.response('10')]);
  assert.equal(starts, 1, 'concurrent calls share one startup');
  assert.deepEqual(b.messages.find((message) => message.method === 'initialize').params.capabilities, { sampling: {} });
  assert.equal(b.messages.filter((message) => message.method === 'notifications/initialized').length, 1);
  assert.deepEqual(b.messages.find((message) => message.method === 'logging/setLevel').params, { level: 'warning' });
  assert.ok(b.messages.findIndex((message) => message.method === 'logging/setLevel') < b.messages.findIndex((message) => message.method === 'tools/call'), 'cached logging level is applied before first actual operation');
  f.send({ id: 'ready-logging', method: 'logging/setLevel', params: { level: 'error' } });
  assert.deepEqual((await f.response('ready-logging')).result, {});
  assert.deepEqual(b.messages.filter((message) => message.method === 'logging/setLevel').at(-1).params, { level: 'error' }, 'ready backend receives logging change as a real request');
  const callIds = b.messages.filter((message) => message.method === 'tools/call').map((message) => message.id);
  assert.equal(new Set(callIds).size, 2, 'number/string host IDs cannot collide');
  assert.ok(f.received.some((message) => message.method === 'notifications/progress'));
  b.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'roots/list' })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const callback = f.received.find((message) => message.method === 'roots/list');
  assert.notEqual(callback.id, 10);
  f.send({ id: callback.id, result: { roots: [] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(b.messages.at(-1), { jsonrpc: '2.0', id: 10, result: { roots: [] } });
  f.input.end(); assert.equal(await f.completion, 0);

  // A catalog source that cannot produce a matching catalog (backendDiscovery) makes the real backend answer discovery.
  {
    let catalogCalls = 0, discoveryStarts = 0;
    const discoveryBackend = backend();
    discoveryBackend.child.stdin.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) {
        const message = JSON.parse(line);
        if (message.method === 'tools/list') discoveryBackend.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'live-tool', inputSchema: { type: 'object' } }] } })}\n`);
        if (message.method === 'resources/list') discoveryBackend.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { resources: [] } })}\n`);
      }
    });
    const stale = fixture(async () => { discoveryStarts++; return discoveryBackend.child; }, {
      catalog: async () => { catalogCalls++; throw Object.assign(new Error('catalog export failed'), { backendDiscovery: true }); },
    });
    stale.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'host', version: '1' } } });
    const initialized = await stale.response(1);
    assert.equal(initialized.result.serverInfo.name, 'fixture', 'initialize is answered by the backend, not a stale catalog');
    assert.equal(discoveryStarts, 1, 'backend discovery starts the backend');
    stale.send({ id: 2, method: 'tools/list' });
    assert.deepEqual((await stale.response(2)).result.tools.map((tool) => tool.name), ['live-tool'], 'tools/list comes from the live backend');
    stale.send({ id: 3, method: 'resources/list' });
    assert.deepEqual((await stale.response(3)).result.resources, []);
    stale.send({ id: 4, method: 'tools/call', params: { name: 'example' } });
    assert.ok((await stale.response(4)).result);
    assert.equal(discoveryStarts, 1);
    assert.equal(catalogCalls, 1, 'a failed catalog is not retried for every request');
    stale.input.end(); await stale.completion;

    // Other catalog failures remain request errors instead of silently starting the backend.
    const broken = fixture(async () => { throw new Error('must not start'); }, { catalog: async () => { throw new Error('corrupt'); } });
    broken.send({ id: 1, method: 'tools/list' });
    assert.match((await broken.response(1)).error.message, /corrupt/);
    broken.input.end(); await broken.completion;
  }

  let attempts = 0;
  const retryBackend = backend();
  const retry = fixture(async () => { if (++attempts === 1) throw new Error('cold failed'); return retryBackend.child; });
  retry.send({ id: 'retry-logging', method: 'logging/setLevel', params: { level: 'debug' } });
  assert.deepEqual((await retry.response('retry-logging')).result, {});
  assert.equal(attempts, 0);
  retry.send({ id: 1, method: 'tools/call', params: { name: 'example' } });
  assert.match((await retry.response(1)).error.message, /cold failed/);
  retry.send({ id: 2, method: 'tools/call', params: { name: 'example' } });
  assert.ok((await retry.response(2)).result); assert.equal(attempts, 2);
  assert.deepEqual(retryBackend.messages.find((message) => message.method === 'logging/setLevel').params, { level: 'debug' }, 'retry handshake must replay saved logging level');
  retry.input.end(); await retry.completion;

  const queuedBackend = backend();
  queuedBackend.child.stdin.removeAllListeners('data');
  queuedBackend.child.stdin.on('data', (chunk) => {
    const message = JSON.parse(String(chunk)); queuedBackend.messages.push(message);
    if (message.method === 'initialize') queuedBackend.child.stdout.write(`${JSON.stringify({ id: message.id, result: catalog })}\n`);
    if (message.method === 'tools/call' || (message.method === 'logging/setLevel' && message.params.level === 'error')) {
      queuedBackend.child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
  });
  const queued = fixture(async () => queuedBackend.child);
  try {
    queued.send({ id: 'level', method: 'logging/setLevel', params: { level: 'warning' } }); await queued.response('level');
    queued.send({ id: 'call', method: 'tools/call', params: { name: 'example' } });
    while (!queuedBackend.messages.some((message) => message.method === 'logging/setLevel')) await new Promise((resolve) => setImmediate(resolve));
    const replay = queuedBackend.messages.find((message) => message.method === 'logging/setLevel');
    // Queue the response into the replay continuation first; a later host request then awaits the cached catalog.
    // Do not inject from the synchronous stdin mock write callback; cover the real queue order with the external response arriving first.
    queuedBackend.child.stdout.write(`${JSON.stringify({ id: replay.id, result: {} })}\n`);
    queued.send({ id: 'latest-level', method: 'logging/setLevel', params: { level: 'error' } });
    queued.send({ method: 'notifications/roots/list_changed' });
    await Promise.all([queued.response('call'), queued.response('latest-level')]);
    assert.deepEqual(queuedBackend.messages.filter((message) => message.method === 'logging/setLevel').map((message) => message.params.level), ['warning', 'error'], 'startup publishes readiness without losing a logging request queued after replay acknowledgement');
    assert.equal(queued.proxy.loggingLevel, 'error'); assert.equal(queued.proxy.ready, true);
    assert.equal(queued.proxy.notifications.length, 0);
    assert.ok(queuedBackend.messages.findIndex((message) => message.method === 'notifications/roots/list_changed') < queuedBackend.messages.findIndex((message) => message.method === 'tools/call'), 'notifications queued at replay completion flush before actual operation');
  } finally { queued.input.end(); await queued.completion; }

  const cancelledBackend = backend();
  let release;
  const cancelled = fixture(() => new Promise((resolve) => { release = () => resolve(cancelledBackend.child); }));
  cancelled.send({ id: 20, method: 'tools/call', params: { name: 'example', _meta: { progressToken: 'cancel' } } });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  cancelled.send({ method: 'notifications/cancelled', params: { requestId: 20, reason: 'stop queued request' } });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  cancelled.send({ id: 21, method: 'ping' }); await cancelled.response(21);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelledBackend.messages.filter((message) => message.method === 'tools/call').length, 0);
  assert.equal(cancelled.received.some((message) => message.id === 20), false, 'cancelled queued request must not receive a response');
  cancelled.input.end(); await cancelled.completion;

  let killed = 0;
  const hung = backend();
  hung.child.stdin.removeAllListeners('data');
  const timeout = fixture(async () => hung.child, { startupTimeoutMs: 25, killTree: async (child) => { killed++; child.emit('exit', 0); } });
  timeout.send({ id: 30, method: 'tools/call', params: { name: 'example' } });
  timeout.send({ id: 31, method: 'ping' });
  assert.deepEqual((await timeout.response(31)).result, {}, 'ping remains responsive during cold handshake');
  assert.match((await timeout.response(30)).error.message, /timeout/);
  assert.equal(killed, 1, 'hung backend must be reaped');
  timeout.input.end(); await timeout.completion;

  let aborted = false;
  const eof = fixture((signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }));
  eof.send({ id: 40, method: 'tools/call', params: { name: 'example' } });
  await new Promise((resolve) => setImmediate(resolve));
  eof.input.end(); assert.equal(await eof.completion, 0);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(aborted, true, 'stdin EOF cancels preparation');

  const interactiveBackend = backend();
  interactiveBackend.child.stdin.removeAllListeners('data');
  const seen = [];
  interactiveBackend.child.stdin.on('data', (chunk) => {
    const message = JSON.parse(String(chunk)); seen.push(message);
    if (message.method === 'initialize') interactiveBackend.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: catalog })}\n`);
    if (message.method === 'tools/call') interactiveBackend.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: message.params._meta.progressToken, progress: 0, total: 2 } })}\n`);
  });
  const interactive = fixture(async () => interactiveBackend.child);
  interactive.send({ id: 50, method: 'tools/call', params: { name: 'example', _meta: { progressToken: 'real' } } });
  while (!seen.some((message) => message.method === 'tools/call')) await new Promise((resolve) => setImmediate(resolve));
  const progress = interactive.received.filter((message) => message.method === 'notifications/progress');
  assert.equal(progress.at(-1).params.progressToken, 'real');
  assert.ok(progress.at(-1).params.progress > progress[0].params.progress, 'backend progress must increase after proxy cold progress');
  interactive.send({ method: 'notifications/cancelled', params: { requestId: 50, reason: 'cancel forwarded operation' } });
  await new Promise((resolve) => setImmediate(resolve));
  const cancelledCall = seen.find((message) => message.method === 'tools/call');
  assert.equal(seen.at(-1).params.requestId, cancelledCall.id);
  interactiveBackend.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: cancelledCall.id, result: {} })}\n`);
  assert.equal(interactive.received.some((message) => message.id === 50), false);
  interactiveBackend.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'cb', method: 'sampling/createMessage' })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const cb = interactive.received.find((message) => message.method === 'sampling/createMessage');
  interactiveBackend.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cb' } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interactive.received.at(-1).params.requestId, cb.id, 'backend cancellation maps callback ID to host namespace');
  interactive.send({ method: 'notifications/roots/list_changed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.at(-1).method, 'notifications/roots/list_changed');
  interactive.input.end(); await interactive.completion;
  console.log('lazy_mcp.test.js PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
