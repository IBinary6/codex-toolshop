'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const readline = require('node:readline');
const test = require('node:test');
const { LazyMcp } = require('../scripts/lazy_mcp.cjs');

const initialize = {
  protocolVersion: '2025-06-18',
  capabilities: { sampling: {}, roots: { listChanged: true } },
  clientInfo: { name: 'test-host', version: '2' },
  _meta: { fixture: 'must be forwarded' },
};
const result = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {}, prompts: {}, resources: {}, logging: {} },
  serverInfo: { name: 'fake-debugger', version: '1' },
  instructions: 'Real backend instructions',
};
const tool = {
  name: 'first', title: 'First tool', description: '第一项',
  inputSchema: { type: 'object', properties: { token: { type: 'string' } } },
  outputSchema: { type: 'object', properties: { data: { type: 'integer' } } },
  annotations: { readOnlyHint: true },
  _meta: { optionalFixtureField: true },
};
const nextTool = { name: 'second', inputSchema: { type: 'object' } };

const fixture = String.raw`
const fs = require('node:fs');
const options = JSON.parse(process.argv[1]);
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const read = require('node:readline').createInterface({ input: process.stdin });
const pending = new Map();
if (options.ignoreEof) setInterval(() => {}, 1000);
read.on('line', (line) => {
  const req = JSON.parse(line);
  fs.appendFileSync(options.log, JSON.stringify(req) + '\n');
  const reply = (result) => send({ id: req.id, result });
  if (req.method === 'initialize') return reply(options.init);
  if (req.method === 'notifications/initialized') return;
  if (req.method === 'tools/list') {
    if (options.hangDiscovery) return;
    if (req.params?.cursor) return reply({ tools: options.tools.slice(1), ...(options.pageMeta ? { _meta: { page: 2 } } : {}) });
    const page = { tools: options.tools.slice(0, 1), ...(options.tools.length > 1 ? { nextCursor: 'private-paging-cursor' } : {}),
      ...(options.pageMeta ? { _meta: { page: 1 } } : {}) };
    if (options.delayDiscoveryMs) setTimeout(() => reply(page), options.delayDiscoveryMs);
    else reply(page);
    return;
  }
  if (req.method === 'tools/call' && req.params.name === 'crash') process.exit(4);
  if (req.method === 'tools/call' && req.params.name === 'sample') {
    pending.set(req.id, req);
    send({ id: req.id, method: 'sampling/createMessage', params: { maxTokens: 8, messages: [] } });
    return;
  }
  if (!req.method && pending.has(req.id)) {
    const call = pending.get(req.id);
    pending.delete(req.id);
    send({ method: 'notifications/progress', params: { progressToken: call.params._meta.progressToken, progress: 1, total: 1 } });
    return reply({ isError: !!req.error, content: [], structuredContent: req.error || req.result });
  }
  if (req.method === 'resources/read') {
    return send({ id: req.id, error: { code: -32004, message: 'Resource absent', data: { uri: req.params.uri } } });
  }
  reply({ pid: process.pid, params: req.params });
});
`;

async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function harness(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-lazy-test-'));
  const cacheFile = path.join(temp, 'catalog.json');
  const log = path.join(temp, 'backend.ndjson');
  const frontends = [];
  const children = [];
  const requestLog = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const settings = { init: result, tools: [tool, nextTool], log };
  let snapshot = { cacheable: true, fingerprint: 'state-v1' };
  const open = (options = {}) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const messages = [];
    const lines = readline.createInterface({ input: output });
    lines.on('line', (line) => messages.push(JSON.parse(line)));
    const proxy = new LazyMcp({
      cacheFile,
      snapshot: () => snapshot,
      launch() {
        const child = spawn(process.execPath, ['-e', fixture, JSON.stringify(settings)], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        children.push(child);
        return child;
      },
      input, output, watchProcess: false, discoveryGraceMs: 120, stopGraceMs: 100, ...options,
    }).start();
    const send = (message) => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    const response = (id) => waitFor(() => messages.find((message) => !message.method && message.id === id));
    const request = (id, method, params) => {
      send({ id, method, params });
      return response(id);
    };
    const init = async (params = initialize) => {
      const response = await request('init', 'initialize', params);
      assert.ok(response.result, JSON.stringify(response));
      send({ method: 'notifications/initialized', params: { test: 'notification' } });
      return response.result;
    };
    const close = async () => {
      input.end();
      await proxy.finished;
      lines.close();
    };
    frontends.push(close);
    return { messages, send, response, request, init, close, finished: proxy.finished };
  };
  t.after(async () => {
    await Promise.all(frontends.map((close) => close()));
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { open, children, settings, cacheFile, requestLog, setSnapshot: (value) => { snapshot = value; } };
}

function exited(child) { return child.exitCode !== null || child.signalCode !== null; }

test('cold discovery fetches full real tool schemas once, retires, then warm sessions launch zero backends', async (t) => {
  const h = harness(t);
  const cold = h.open();
  assert.deepEqual(await cold.init(), result);
  const lists = await Promise.all(['a', 'b', 'c'].map((id) => cold.request(id, 'tools/list')));
  for (const list of lists) assert.deepEqual(list.result.tools, [tool, nextTool]);
  assert.equal(h.children.length, 1);
  await waitFor(() => exited(h.children[0]));
  assert.equal(h.requestLog().filter((item) => item.method === 'tools/list').length, 2);
  assert.deepEqual(h.requestLog().find((item) => item.method === 'initialize').params, initialize);
  assert.ok(!fs.readFileSync(h.cacheFile, 'utf8').includes('private-paging-cursor'));

  const warm = [h.open(), h.open(), h.open()];
  await Promise.all(warm.map(async (client) => {
    assert.deepEqual(await client.init(), result);
    assert.deepEqual((await client.request('list', 'tools/list')).result.tools, [tool, nextTool]);
    assert.deepEqual((await client.request('ping', 'ping')).result, {});
  }));
  assert.equal(h.children.length, 1, 'all three concurrent warm chats keep zero debugger backends');
});

test('a handshake-only discovery backend also retires', async (t) => {
  const h = harness(t);
  await h.open().init();
  assert.equal(h.children.length, 1);
  await waitFor(() => exited(h.children[0]));
});

test('an unresponsive discovery RPC is bounded and its backend retires', async (t) => {
  const h = harness(t);
  h.settings.hangDiscovery = true;
  const client = h.open({ discoveryTimeoutMs: 40 });
  await client.init();
  assert.match((await client.request(1, 'tools/list')).error.message, /timed out for tools\/list/);
  await waitFor(() => exited(h.children[0]));
  assert.ok(!fs.existsSync(h.cacheFile));
});

test('cancelling the last discovery request forwards its reason and promptly retires the backend', async (t) => {
  const h = harness(t);
  h.settings.hangDiscovery = true;
  const client = h.open();
  await client.init();
  client.send({ id: 1, method: 'tools/list' });
  const forwarded = await waitFor(() => h.requestLog().find((item) => item.method === 'tools/list'));
  client.send({ method: 'notifications/cancelled', params: { requestId: 1, reason: 'host cancelled discovery' } });
  await waitFor(() => exited(h.children[0]));
  assert.deepEqual(h.requestLog().find((item) => item.method === 'notifications/cancelled').params,
    { requestId: forwarded.id, reason: 'host cancelled discovery' });
  assert.ok(!client.messages.some((item) => item.id === 1));
});

test('cancelling one concurrent discovery leaves the other subscriber and an active backend intact', async (t) => {
  const h = harness(t);
  h.settings.delayDiscoveryMs = 200;
  const client = h.open();
  await client.init();
  client.send({ id: 1, method: 'tools/list' });
  client.send({ id: 2, method: 'tools/list' });
  await waitFor(() => h.requestLog().find((item) => item.method === 'tools/list'));
  client.send({ method: 'notifications/cancelled', params: { requestId: 1 } });
  assert.equal((await client.request(3, 'prompts/list')).result.pid, h.children[0].pid);
  assert.deepEqual((await client.response(2)).result.tools, [tool, nextTool]);
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.ok(!exited(h.children[0]));
  assert.ok(!client.messages.some((item) => item.id === 1));
  assert.ok(!h.requestLog().some((item) => item.method === 'notifications/cancelled'));
  await client.close();
  assert.ok(exited(h.children[0]));
});

test('cancelling the last discovery request after activation preserves the backend', async (t) => {
  const h = harness(t);
  h.settings.hangDiscovery = true;
  const client = h.open();
  await client.init();
  client.send({ id: 1, method: 'tools/list' });
  await waitFor(() => h.requestLog().find((item) => item.method === 'tools/list'));
  assert.equal((await client.request(2, 'prompts/list')).result.pid, h.children[0].pid);
  client.send({ method: 'notifications/cancelled', params: { requestId: 1 } });
  await waitFor(() => h.requestLog().find((item) => item.method === 'notifications/cancelled'));
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal((await client.request(3, 'prompts/list')).result.pid, h.children[0].pid);
  assert.ok(!exited(h.children[0]));
});

test('first active concurrent requests share one backend, which remains until host EOF', async (t) => {
  const h = harness(t);
  const cold = h.open();
  await cold.init();
  await cold.request('list', 'tools/list');
  await waitFor(() => exited(h.children[0]));
  const warm = h.open();
  await warm.init();
  const [prompts, resource] = await Promise.all([
    warm.request(1, 'prompts/list', { marker: 'live' }),
    warm.request(2, 'resources/read', { uri: 'test://missing' }),
  ]);
  assert.equal(h.children.length, 2);
  assert.equal(prompts.result.pid, h.children[1].pid);
  assert.deepEqual(resource.error, { code: -32004, message: 'Resource absent', data: { uri: 'test://missing' } });
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.ok(!exited(h.children[1]), 'active debugger state survives idle');
  const logging = await warm.request(3, 'logging/setLevel', { level: 'debug' });
  assert.equal(logging.result.pid, prompts.result.pid);
  assert.deepEqual(h.requestLog().filter((item) => item.method === 'notifications/initialized').map((item) => item.params),
    [{ test: 'notification' }, { test: 'notification' }]);
  await warm.close();
  assert.ok(exited(h.children[1]));
});

test('sampling callbacks, directional request IDs, progress and structured errors round-trip', async (t) => {
  const h = harness(t);
  const client = h.open();
  await client.init();
  for (const [hostId, answer] of [
    [7, { result: { role: 'assistant', content: { type: 'text', text: 'sampled' }, model: 'test' } }],
    ['7', { error: { code: -32601, message: 'Sampling unavailable', data: { retained: true } } }],
  ]) {
    client.send({ id: hostId, method: 'tools/call', params: { name: 'sample', _meta: { progressToken: hostId } } });
    const callback = await waitFor(() => client.messages.find((item) => item.method === 'sampling/createMessage'));
    client.messages.splice(client.messages.indexOf(callback), 1);
    assert.notEqual(callback.id, hostId);
    assert.deepEqual(callback.params, { maxTokens: 8, messages: [] });
    client.send({ id: callback.id, ...answer });
    const forwarded = await client.response(hostId);
    assert.deepEqual(forwarded.result, { isError: !!answer.error, content: [], structuredContent: answer.error || answer.result });
    assert.deepEqual(client.messages.find((item) => item.params?.progressToken === hostId).params,
      { progressToken: hostId, progress: 1, total: 1 });
  }
  assert.equal(h.children.length, 1);
  const calls = h.requestLog().filter((item) => item.method === 'tools/call');
  const callbacks = h.requestLog().filter((item) => !item.method);
  assert.deepEqual(calls.map((item) => item.id), callbacks.map((item) => item.id));
});

test('native dynamic discovery stays live and status-only x32/x64 catalogs do not persist', async (t) => {
  const h = harness(t);
  h.setSnapshot({ cacheable: false, fingerprint: 'native' });
  for (const name of ['live-session-A', 'live-session-B']) {
    h.settings.tools = [{ name }, nextTool];
    const client = h.open();
    await client.init();
    assert.deepEqual((await client.request('list', 'tools/list')).result, { tools: [{ name }, nextTool] });
    await client.close();
  }
  for (const debuggerName of ['x32dbg', 'x64dbg']) {
    const statusTool = 'dbg_' + debuggerName + '_status';
    h.setSnapshot({ cacheable: true, fingerprint: debuggerName, statusTool });
    h.settings.tools = [{ name: statusTool }];
    const client = h.open();
    await client.init();
    assert.deepEqual((await client.request('list', 'tools/list')).result.tools, [{ name: statusTool }]);
    await client.close();
  }
  assert.equal(h.children.length, 4);
  assert.ok(!fs.existsSync(h.cacheFile));
});

test('unmergeable dynamic tool pages keep their original cursor and use the same backend until completion', async (t) => {
  const h = harness(t);
  h.setSnapshot({ cacheable: false, fingerprint: 'native' });
  h.settings.pageMeta = true;
  const client = h.open({ pageGraceMs: 1000 });
  await client.init();
  const first = await client.request(1, 'tools/list');
  assert.deepEqual(first.result, { tools: [tool], nextCursor: 'private-paging-cursor', _meta: { page: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.ok(!exited(h.children[0]));
  const second = await client.request(2, 'tools/list', { cursor: first.result.nextCursor });
  assert.deepEqual(second.result, { tools: [nextTool], _meta: { page: 2 } });
  assert.equal(h.children.length, 1);
  await waitFor(() => exited(h.children[0]));
  assert.ok(!fs.existsSync(h.cacheFile));
});

test('capabilities, deployment fingerprint and private metadata control cache reuse', async (t) => {
  const h = harness(t);
  const first = h.open();
  await first.init();
  await first.request('list', 'tools/list');
  await first.close();
  const changedHost = h.open();
  await changedHost.init({ ...initialize, capabilities: {} });
  await changedHost.close();
  assert.equal(h.children.length, 2);
  h.setSnapshot({ cacheable: true, fingerprint: 'state-v2', secrets: ['fixture-secret'] });
  h.settings.tools = [{ ...tool, description: 'fixture-secret' }];
  const changedState = h.open();
  await changedState.init();
  assert.equal((await changedState.request('list', 'tools/list')).result.tools[0].description, 'fixture-secret');
  assert.equal(h.children.length, 3);
  assert.ok(!fs.readFileSync(h.cacheFile, 'utf8').includes('fixture-secret'));
  await changedState.close();
  await h.open().init();
  assert.equal(h.children.length, 4);
});

test('WinDbg initialize contract change fails before forwarding any formerly advertised call', async (t) => {
  const h = harness(t);
  h.setSnapshot({ cacheable: false, fingerprint: 'native' });
  h.settings.init = { ...result, serverInfo: { name: 'Native WinDbg', version: '1' } };
  const client = h.open();
  await client.init();
  await client.request('list', 'tools/list');
  await waitFor(() => exited(h.children[0]));
  h.settings.init = { ...result, serverInfo: { name: 'Legacy WinDbg', version: '1' } };
  const response = await client.request(1, 'tools/call', { name: 'first' });
  assert.match(response.error.message, /initialize contract changed/);
  assert.equal(h.children.length, 2);
  assert.equal(h.requestLog().filter((item) => item.method === 'tools/call').length, 0);
});

test('an active backend crash is never replayed or restarted inside the session', async (t) => {
  const h = harness(t);
  const client = h.open();
  await client.init();
  const response = await client.request(1, 'tools/call', { name: 'crash' });
  assert.match(response.error.message, /disconnected/);
  await waitFor(() => exited(h.children[0]));
  const later = await client.request(2, 'tools/call', { name: 'first' });
  assert.match(later.error.message, /disconnected/);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.requestLog().filter((item) => item.method === 'tools/call').map((item) => item.params.name), ['crash']);
});

test('owner exit closes a session with open stdio and forces its uncooperative child to exit', async (t) => {
  const h = harness(t);
  h.settings.ignoreEof = true;
  let ownerAlive = true;
  const client = h.open({ watchProcess: true, ownerCheckMs: 25, ownerAlive: () => ownerAlive });
  await client.init();
  await client.request(1, 'tools/call', { name: 'first' });
  ownerAlive = false;
  await client.finished;
  assert.ok(exited(h.children[0]));
});
