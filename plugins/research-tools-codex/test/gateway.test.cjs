'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { Gateway, runStdio, readRpc, PROTOCOL, REMOTE_PROVIDERS } = require('../scripts/gateway.cjs');
const { configPath, readConfig, createConfig } = require('../scripts/config.cjs');
const catalog = require('../scripts/catalog.json');
const tick = () => new Promise(resolve => setImmediate(resolve));
const keys = { context7: 'synthetic-context7', exa: 'synthetic-exa', tavily: 'synthetic-tavily +/&?' };

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-tools-test-'));
  const file = path.join(directory, 'config.json');
  const write = overrides => fs.writeFileSync(file, JSON.stringify({ version: 1, ...Object.fromEntries(Object.entries({ ...keys, ...overrides }).map(([name, apiKey]) => [name, { apiKey }])) }));
  write(options.keys);
  const calls = [];
  const fetch = options.fetch || (async (url, init) => {
    const rpc = JSON.parse(init.body);
    const record = { url, init, rpc };
    calls.push(record);
    if (options.handler) { const response = await options.handler(record, calls); if (response) return response; }
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = rpc.method === 'initialize' ? { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } : { content: [{ type: 'text', text: 'mock-result' }], structuredContent: { ok: true }, isError: false };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), { headers: { 'content-type': 'application/json', ...(rpc.method === 'initialize' ? { 'Mcp-Session-Id': `session-${new URL(url).hostname}` } : {}) } });
  });
  const gateway = new Gateway({ configFile: file, fetch, ...options.gateway });
  t.after(() => { gateway.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { gateway, file, directory, calls, write };
}

function blockedFetch(record) {
  return new Promise((resolve, reject) => {
    if (record.init.signal.aborted) { reject(new Error('aborted synthetic-secret')); return; }
    record.init.signal.addEventListener('abort', () => reject(new Error('aborted synthetic-secret')), { once: true });
  });
}

test('cold initialize, ping and all fourteen schemas use zero HTTP or local backends, including missing config', async t => {
  const { gateway, file, calls } = fixture(t);
  fs.unlinkSync(file);
  assert.equal((await gateway.dispatch({ method: 'initialize' })).capabilities.tools.constructor, Object);
  assert.deepEqual(await gateway.dispatch({ method: 'ping' }), {});
  assert.deepEqual((await gateway.dispatch({ method: 'tools/list' })).tools, Object.values(catalog.providers).flat());
  assert.equal(calls.length, 0);
  assert.equal(gateway.states.size, 0);
  assert.equal(gateway.local.size, 0);
  assert.equal(gateway.tools.length, 14);
});

test('first gateway startup exclusively creates global empty JSON without network or overwriting credentials', async t => {
  const { directory } = fixture(t);
  const file = path.join(directory, 'automatic/research-tools/config.json');
  let fetches = 0;
  const gateway = new Gateway({ env: { CODEX_HOME: path.join(directory, 'automatic') }, fetch: () => { fetches++; throw new Error('should not fetch'); } });
  t.after(() => gateway.close());
  assert.equal(gateway.file, file);
  assert.deepEqual(readConfig(file), { version: 1, context7: { apiKey: '' }, exa: { apiKey: '' }, tavily: { apiKey: '' } });
  await gateway.dispatch({ method: 'tools/list' });
  const configured = { version: 1, context7: { apiKey: 'synthetic-preserved' }, exa: { apiKey: '' }, tavily: { apiKey: '' } };
  fs.writeFileSync(file, JSON.stringify(configured));
  const second = new Gateway({ configFile: file, fetch: () => { fetches++; throw new Error('should not fetch'); } });
  second.close();
  assert.deepEqual(readConfig(file), configured);
  assert.equal(fetches, 0);
});

test('all twelve remote tools route to provider, use correct authentication, protocol/session headers and preserve results', async t => {
  const { gateway, calls } = fixture(t);
  for (const provider of REMOTE_PROVIDERS) {
    const tools = catalog.providers[provider];
    for (const tool of tools) {
      const args = tool.name === 'web_search_exa' ? { query: 'test', objective: 'explicit' } : { sample: 'forwarded' };
      const params = { name: tool.name, arguments: args, _meta: { trace: 'kept' } };
      const result = await gateway.call(params);
      assert.deepEqual(result, { content: [{ type: 'text', text: 'mock-result' }], structuredContent: { ok: true }, isError: false });
      const last = calls.at(-1);
      assert.deepEqual(last.rpc.params, params);
      assert.equal(last.init.headers['MCP-Protocol-Version'], PROTOCOL);
      assert.match(last.init.headers['Mcp-Session-Id'], /^session-/);
      assert.equal(last.init.headers['User-Agent'], 'Mozilla/5.0');
      assert.equal(new URL(last.url).hostname, { context7: 'mcp.context7.com', exa: 'mcp.exa.ai', tavily: 'mcp.tavily.com', microsoft: 'learn.microsoft.com' }[provider]);
      if (provider === 'context7') assert.equal(last.init.headers.Authorization, `Bearer ${keys.context7}`);
      if (provider === 'exa') assert.equal(last.init.headers['x-api-key'], keys.exa);
      if (provider === 'tavily') assert.equal(new URL(last.url).searchParams.get('tavilyApiKey'), keys.tavily);
      if (provider === 'microsoft') {
        assert.equal(new URL(last.url).pathname, '/api/mcp');
        assert.equal(last.init.headers.Authorization, undefined);
        assert.equal(last.init.headers['x-api-key'], undefined);
        assert.equal(new URL(last.url).search, '');
      }
    }
  }
  assert.equal(calls.filter(call => call.rpc.method === 'initialize').length, 4);
  assert.equal(calls.filter(call => call.rpc.method === 'notifications/initialized').length, 4);
  assert.equal(calls.filter(call => call.rpc.method === 'tools/call').length, 12);
});

test('Context7 anonymous access is allowed and missing Exa/Tavily keys guide setup without HTTP', async t => {
  const { gateway, calls } = fixture(t, { keys: { context7: '', exa: '', tavily: '' } });
  await gateway.call({ name: 'query-docs', arguments: { libraryId: '/test/lib', query: 'test' } });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  const count = calls.length;
  for (const name of ['web_search_exa', 'tavily_search']) {
    const result = await gateway.dispatch({ method: 'tools/call', params: { name, arguments: { query: 'test' } } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /setup\.cjs/);
  }
  assert.equal(calls.length, count);
});

test('Exa compatibility adapter supplies objective only when omitted and never mutates input', async t => {
  const { gateway, calls } = fixture(t);
  const query = 'x'.repeat(5000);
  const params = { name: 'web_search_exa', arguments: { query, numResults: 2 } };
  await gateway.call(params);
  assert.equal(calls.at(-1).rpc.params.arguments.objective, query.slice(0, 4096));
  assert.equal(Object.hasOwn(params.arguments, 'objective'), false);
  await gateway.call({ name: 'web_search_exa', arguments: { query: 'x', objective: 'explicit', numResults: 1 } });
  assert.equal(calls.at(-1).rpc.params.arguments.objective, 'explicit');
});

test('simultaneous calls deduplicate initialization and later calls reuse the session', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { gateway, calls } = fixture(t, { handler: async record => { if (record.rpc.method === 'initialize') await gate; } });
  const a = gateway.call({ name: 'query-docs', arguments: { query: 'a' } });
  const b = gateway.call({ name: 'resolve-library-id', arguments: { query: 'b' } });
  await tick();
  assert.equal(calls.length, 1);
  release();
  await Promise.all([a, b]);
  await gateway.call({ name: 'query-docs', arguments: { query: 'c' } });
  assert.equal(calls.filter(call => call.rpc.method === 'initialize').length, 1);
  assert.equal(calls.filter(call => call.rpc.method === 'tools/call').length, 3);
});

test('JSON config is reread on each call; changed key resets only the affected provider', async t => {
  const { gateway, calls, write } = fixture(t);
  await gateway.call({ name: 'web_fetch_exa', arguments: { url: 'https://example.org' } });
  await gateway.call({ name: 'tavily_search', arguments: { query: 'x' } });
  write({ exa: 'synthetic-rotated-key' });
  await gateway.call({ name: 'web_fetch_exa', arguments: { url: 'https://example.org' } });
  assert.equal(calls.at(-1).init.headers['x-api-key'], 'synthetic-rotated-key');
  await gateway.call({ name: 'tavily_search', arguments: { query: 'x' } });
  assert.equal(calls.filter(call => call.rpc.method === 'initialize' && new URL(call.url).hostname === 'mcp.exa.ai').length, 2);
  assert.equal(calls.filter(call => call.rpc.method === 'initialize' && new URL(call.url).hostname === 'mcp.tavily.com').length, 1);
});

test('SSE arbitrary chunks, CRLF, notifications and other request IDs are consumed until matching response then cancelled', async () => {
  let cancelled = false;
  const rpc = { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: '\u4e2d\u6587✓' }] } };
  const source = ': heartbeat\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\ndata: {"jsonrpc":"2.0","id":6,"result":{}}\r\n\r\nevent: message\r\ndata: ' + JSON.stringify(rpc) + '\r\n\r\n';
  const bytes = new TextEncoder().encode(source);
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); }, cancel() { cancelled = true; } });
  const result = await readRpc(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), 7, new AbortController().signal);
  assert.deepEqual(result, rpc);
  assert.equal(cancelled, true);
});

test('HTTP 404 session recovery is bounded to one new handshake and forwards same call', async t => {
  let attempts = 0;
  const { gateway, calls } = fixture(t, { handler: record => {
    if (record.rpc.method === 'tools/call' && attempts++ === 0) return new Response('sensitive body', { status: 404 });
  } });
  const result = await gateway.call({ name: 'query-docs', arguments: { query: 'a' } });
  assert.equal(result.isError, false);
  assert.equal(calls.filter(call => call.rpc.method === 'initialize').length, 2);
  assert.equal(calls.filter(call => call.rpc.method === 'tools/call').length, 2);
  const { gateway: failing, calls: failedCalls } = fixture(t, { handler: record => record.rpc.method === 'tools/call' ? new Response('sensitive body', { status: 401 }) : undefined });
  await assert.rejects(failing.call({ name: 'query-docs' }), /HTTP 401/);
  assert.equal(failedCalls.filter(call => call.rpc.method === 'tools/call').length, 2);
});

test('one cancelled initialization waiter does not abort a second waiter', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { gateway, calls } = fixture(t, { handler: async record => { if (record.rpc.method === 'initialize') await gate; } });
  const controller = new AbortController();
  const first = gateway.call({ name: 'query-docs' }, controller.signal);
  const second = gateway.call({ name: 'query-docs' });
  controller.abort();
  await assert.rejects(first, /cancelled or timed out/);
  release();
  assert.equal((await second).isError, false);
  assert.equal(calls.filter(call => call.rpc.method === 'initialize').length, 1);
});

test('timeout and explicit cancellation abort tools/call, use generic errors and clean controllers', async t => {
  const { gateway } = fixture(t, { handler: record => record.rpc.method === 'tools/call' ? blockedFetch(record) : undefined, gateway: { timeoutMs: 30 } });
  await assert.rejects(gateway.call({ name: 'query-docs' }), /cancelled or timed out/);
  assert.equal(gateway.controllers.size, 0);
  const controller = new AbortController();
  const promise = gateway.call({ name: 'query-docs' }, controller.signal);
  await tick();
  controller.abort();
  await assert.rejects(promise, /cancelled or timed out/);
  assert.equal(gateway.controllers.size, 0);
});

test('SSE timeout cancels reader even when stream never produces a result', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': keepalive\n\n')); }, cancel() { cancelled = true; } });
  const controller = new AbortController();
  const promise = readRpc(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), 1, controller.signal);
  controller.abort();
  await assert.rejects(promise, /cancelled or timed out/);
  assert.equal(cancelled, true);
});

test('remote HTTP, RPC and thrown transport errors never expose bodies, URLs or secrets', async t => {
  for (const mode of ['http', 'rpc', 'transport']) {
    const { gateway } = fixture(t, { handler: record => {
      if (record.rpc.method !== 'tools/call') return;
      const sensitive = `${keys.tavily} https://mcp.tavily.com/mcp/?tavilyApiKey=${encodeURIComponent(keys.tavily)}`;
      if (mode === 'http') return new Response(sensitive, { status: 500 });
      if (mode === 'transport') throw new Error(sensitive);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: record.rpc.id, error: { code: -32000, message: sensitive } }));
    } });
    const result = await gateway.dispatch({ method: 'tools/call', params: { name: 'tavily_search' } });
    const output = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.doesNotMatch(output, /synthetic-|mcp\.tavily\.com|tavilyApiKey/);
  }
});

test('tool content, structured content, object keys and URL encodings redact private credentials', async t => {
  const { gateway } = fixture(t, { handler: record => {
    if (record.rpc.method !== 'tools/call') return;
    const result = { content: [{ type: 'text', text: `${keys.exa} ${keys.tavily} ${encodeURIComponent(keys.tavily)} ${new URLSearchParams({ key: keys.tavily })}` }], structuredContent: { [keys.context7]: ['https://mcp.tavily.com/mcp/?tavilyApiKey=other-sensitive-key', keys.exa] }, isError: true, ignored: 'drop me' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: record.rpc.id, result }));
  } });
  const result = await gateway.call({ name: 'web_fetch_exa' });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-|other-sensitive-key|drop me/);
  assert.equal(result.isError, true);
  assert.ok(result.structuredContent['[REDACTED]']);
});

test('invalid config is safe, unknown tools and unsupported resources/prompts never use HTTP', async t => {
  const { gateway, file, calls } = fixture(t);
  fs.writeFileSync(file, `{not valid ${keys.exa}`);
  const result = await gateway.dispatch({ method: 'tools/call', params: { name: 'web_search_exa' } });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-/);
  await assert.rejects(gateway.call({ name: 'missing' }), /Invalid Research Tools tool name/);
  await assert.rejects(gateway.dispatch({ method: 'resources/list' }), /Unsupported/);
  await assert.rejects(gateway.dispatch({ method: 'prompts/list' }), /Unsupported/);
  assert.equal(calls.length, 0);
});

test('stdio outputs only JSON-RPC, handles cancellation and aborts pending requests on EOF', async t => {
  const { gateway, calls } = fixture(t, { handler: record => record.rpc.method === 'tools/call' ? blockedFetch(record) : undefined });
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const stdio = runStdio(gateway, { input, output });
  input.write('not json\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'query-docs' } }) + '\n');
  for (let i = 0; i < 20 && !calls.some(call => call.rpc.method === 'tools/call'); i++) await tick();
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }) + '\n');
  await tick();
  const responses = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses[0].error.code, -32700);
  assert.ok(responses.find(response => response.id === 1).result.serverInfo);
  assert.equal(responses.find(response => response.id === 2).result.isError, true);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query-docs' } }) + '\n');
  await tick();
  input.end();
  await tick();
  assert.equal(gateway.closed, true);
  assert.equal(stdio.pending.size, 0);
  assert.ok(calls.at(-1).init.signal.aborted);
});

test('server child exits cleanly on EOF and SIGTERM with no startup diagnostics or HTTP', async t => {
  const { directory } = fixture(t);
  for (const mode of ['eof', 'signal']) {
    const child = spawn(process.execPath, [path.join(__dirname, '../scripts/server.cjs')], { env: { ...process.env, CODEX_HOME: directory, RESEARCH_TOOLS_CONFIG: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    const done = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
    if (mode === 'eof') child.stdin.end();
    else {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
      await new Promise(resolve => child.stdout.once('data', resolve));
      child.kill('SIGTERM');
    }
    const result = await done;
    if (mode === 'eof') assert.equal(result.code, 0);
    assert.equal(err, '');
    if (out) for (const line of out.trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  }
});

test('portable path precedence, exclusive setup and validated private JSON', t => {
  const { directory, file } = fixture(t);
  assert.equal(configPath({}, directory), path.join(directory, '.codex/research-tools/config.json'));
  assert.equal(configPath({ CODEX_HOME: directory }, 'ignored'), path.join(directory, 'research-tools/config.json'));
  assert.equal(configPath({ RESEARCH_TOOLS_CONFIG: file, CODEX_HOME: directory }), file);
  assert.throws(() => configPath({ RESEARCH_TOOLS_CONFIG: 'relative.json' }), /absolute/);
  const before = fs.readFileSync(file);
  assert.equal(createConfig(file), false);
  assert.deepEqual(fs.readFileSync(file), before);
  const fresh = path.join(directory, 'fresh/config.json');
  assert.equal(createConfig(fresh), true);
  assert.deepEqual(readConfig(fresh), { version: 1, context7: { apiKey: '' }, exa: { apiKey: '' }, tavily: { apiKey: '' } });
  for (const bad of [null, { version: 2 }, { version: 1, context7: { apiKey: keys.context7 + '\n' } }, { version: 1, context7: [] }]) {
    fs.writeFileSync(fresh, JSON.stringify(bad));
    assert.throws(() => readConfig(fresh), /Research Tools/);
  }
  assert.throws(() => new Gateway({ configFile: file, timeoutMs: 180001 }), /timeout/);
});
