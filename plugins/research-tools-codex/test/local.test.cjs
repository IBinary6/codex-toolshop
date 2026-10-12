'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ChildTransport } = require('../scripts/child-transport.cjs');
const { Gateway, PROTOCOL, runStdio } = require('../scripts/gateway.cjs');
const { PassThrough } = require('node:stream');
const catalog = require('../scripts/catalog.json');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

async function localFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-local-test-'));
  const backend = path.join(directory, 'backend.cjs');
  const trace = path.join(directory, 'trace.jsonl');
  fs.writeFileSync(backend, `
    const fs = require('node:fs');
    const lines = require('node:readline').createInterface({ input: process.stdin });
    process.stderr.write('private synthetic thought must never escape');
    lines.on('line', line => {
      const m = JSON.parse(line);
      fs.appendFileSync(process.env.TRACE, line + '\\n');
      if (!Object.hasOwn(m, 'id')) return;
      if (m.params?.arguments?.mode === 'crash') { process.exit(7); return; }
      if (m.params?.arguments?.mode === 'hang') return;
      const result = m.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {} }
        : { content: [{ type: 'text', text: JSON.stringify(m.params) }], structuredContent: { passthrough: m.params }, isError: m.params?.arguments?.mode === 'robots' };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    });
  `);
  const children = [];
  const gateway = new Gateway({ configFile: path.join(directory, 'config.json'), fetch: () => { throw new Error('no HTTP'); }, timeoutMs: options.timeoutMs || 10000,
    createLocal: provider => new ChildTransport(provider, async () => ({ command: process.execPath, args: [backend], env: { ...process.env, TRACE: trace } }), {
      spawn: (...args) => { const child = spawn(...args); children.push(child); return child; }
    }) });
  t.after(async () => { await gateway.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const records = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { gateway, children, records, directory };
}

test('Fetch schema and calls preserve official raw/pagination parameters, results and robots errors', async t => {
  const { gateway, records, children } = await localFixture(t);
  const tool = catalog.providers.fetch[0];
  assert.equal(tool.name, 'fetch');
  assert.deepEqual(tool.inputSchema.required, ['url']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['url', 'max_length', 'start_index', 'raw']);
  assert.equal(tool.inputSchema.properties.max_length.default, 5000);
  assert.equal(tool.inputSchema.properties.max_length.exclusiveMaximum, 1000000);
  assert.equal(tool.inputSchema.properties.raw.default, false);
  assert.equal(children.length, 0);
  for (const arguments_ of [
    { url: 'https://example.org', max_length: 17, start_index: 24, raw: true },
    { url: 'https://example.org', max_length: 17, start_index: 41, raw: false },
    { url: 'https://example.org/blocked', mode: 'robots' }
  ]) {
    const params = { name: 'fetch', arguments: arguments_, _meta: { trace: 'unchanged' } };
    const result = await gateway.call(params);
    assert.deepEqual(JSON.parse(result.content[0].text), params);
    assert.deepEqual(result.structuredContent.passthrough, params);
    assert.equal(result.isError, arguments_.mode === 'robots');
  }
  assert.equal(children.length, 1);
  assert.equal(records().filter(r => r.method === 'initialize').length, 1);
  assert.equal(records()[0].params.protocolVersion, PROTOCOL);
  assert.equal(gateway.local.get('fetch').protocol, '2024-11-05');
  assert.equal(records()[1].method, 'notifications/initialized');
  await gateway.close();
  assert.notEqual(children[0].exitCode ?? children[0].signalCode, null);
});

test('child cancellation returns promptly, sends cancellation ID and keeps backend for later calls', async t => {
  const { gateway, records, children } = await localFixture(t);
  await gateway.call({ name: 'fetch', arguments: { url: 'https://example.org' } });
  const controller = new AbortController();
  const pending = gateway.call({ name: 'fetch', arguments: { mode: 'hang' } }, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 25));
  controller.abort();
  await assert.rejects(pending, /cancelled or timed out/);
  await gateway.call({ name: 'fetch', arguments: { url: 'https://example.org/again' } });
  const entries = records();
  const hanging = entries.find(r => r.params?.arguments?.mode === 'hang');
  assert.equal(entries.find(r => r.method === 'notifications/cancelled').params.requestId, hanging.id);
  assert.equal(children.length, 1);
  assert.equal(gateway.controllers.size, 0);
});

test('child timeout aborts waiting and failed backend restarts only on a future call', async t => {
  const { gateway, children } = await localFixture(t);
  await gateway.call({ name: 'fetch', arguments: { url: 'https://example.org' } });
  // Only the hanging call needs the short timeout. Starting and crashing a backend process must not race it:
  // on a loaded Windows runner that took longer than 800 ms and failed main's CI once.
  const normalTimeoutMs = gateway.timeoutMs;
  gateway.timeoutMs = 800;
  await assert.rejects(gateway.call({ name: 'fetch', arguments: { mode: 'hang' } }), /cancelled or timed out/);
  gateway.timeoutMs = normalTimeoutMs;
  assert.equal(children.length, 1);
  await assert.rejects(gateway.call({ name: 'fetch', arguments: { mode: 'crash' } }), /local MCP backend failed/);
  assert.equal(children.length, 1);
  const result = await gateway.call({ name: 'fetch', arguments: { url: 'https://example.org/next' } });
  assert.equal(result.isError, false);
  assert.equal(children.length, 2);
  assert.equal(gateway.controllers.size, 0);
});

test('stdio EOF while local request is pending waits for owned backend cleanup and clears requests', async t => {
  const { gateway, records, children } = await localFixture(t);
  await gateway.call({ name: 'fetch', arguments: { url: 'https://example.org' } });
  const input = new PassThrough();
  const output = new PassThrough();
  const closed = new Promise(resolve => {
    const stdio = runStdio(gateway, { input, output, onClose: () => resolve(stdio) });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fetch', arguments: { mode: 'hang' } } }) + '\n');
  });
  for (let i = 0; i < 100 && !records().some(r => r.params?.arguments?.mode === 'hang'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(records().some(r => r.params?.arguments?.mode === 'hang'));
  input.end();
  const stdio = await closed;
  assert.equal(stdio.pending.size, 0);
  assert.equal(gateway.local.size, 0);
  assert.equal(gateway.closed, true);
  assert.notEqual(children[0].exitCode ?? children[0].signalCode, null);
});

test('local shared initialization survives one cancelled waiter and closes once at gateway shutdown', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-init-test-'));
  let starts = 0, initialized = 0, calls = 0, closes = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const gateway = new Gateway({ configFile: path.join(directory, 'config.json'), createLocal: () => ({
    async start() { starts++; await gate; },
    async request(method) {
      if (method === 'initialize') { initialized++; return { protocolVersion: PROTOCOL }; }
      if (method === 'notifications/initialized') return;
      calls++; return { content: [{ type: 'text', text: 'result' }] };
    },
    async close() { closes++; }
  }) });
  t.after(async () => { await gateway.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const controller = new AbortController();
  const first = gateway.call({ name: 'fetch' }, controller.signal);
  const second = gateway.call({ name: 'fetch' });
  controller.abort();
  await assert.rejects(first, /cancelled or timed out/);
  release();
  await second;
  assert.equal(starts, 1);
  assert.equal(initialized, 1);
  assert.equal(calls, 1);
  assert.equal(closes, 0);
  await gateway.close();
  assert.equal(closes, 1);
});

test('real entry point discovers all tools without network, spawning children or loading local runtimes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-cold-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const guard = path.join(directory, 'guard.cjs');
  fs.writeFileSync(guard, `
    global.fetch = () => { throw new Error('cold HTTP forbidden'); };
    require('node:child_process').spawn = () => { throw new Error('cold child forbidden'); };
    const Module = require('node:module'); const load = Module._load;
    Module._load = function (id, ...args) {
      if (/local-backends|sequential-core/.test(id)) throw new Error('cold runtime forbidden');
      return load.call(this, id, ...args);
    };
  `);
  const child = spawn(process.execPath, ['--require', guard, path.join(__dirname, '../scripts/server.cjs')], {
    env: { ...process.env, CODEX_HOME: directory, RESEARCH_TOOLS_CONFIG: '' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '', stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const response = new Promise(resolve => child.stdout.on('data', value => { output += value; if (output.split('\n').length >= 4) resolve(); }));
  for (const [id, method] of [[1, 'initialize'], [2, 'ping'], [3, 'tools/list']]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method }) + '\n');
  await response;
  const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stdin.end();
  assert.deepEqual(await ended, { code: 0, signal: null });
  assert.equal(stderr, '');
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.find(r => r.id === 1).result.serverInfo.version, '0.1.4');
  assert.equal(replies.find(r => r.id === 3).result.tools.length, 14);
  assert.deepEqual(replies.find(r => r.id === 3).result.tools, Object.values(catalog.providers).flat());
});

test('vendored official core and Chalk match recorded SHA256; only import and notice differ from official core', () => {
  const root = path.join(__dirname, '../vendor/sequential-thinking');
  const provenance = require('../vendor/sequential-thinking/provenance.json');
  assert.equal(provenance.version, '2026.8.31');
  assert.equal(provenance.dependency.version, '5.6.2');
  const sha = data => crypto.createHash('sha256').update(data).digest('hex');
  for (const [file, hash] of Object.entries(provenance.sha256)) assert.equal(sha(fs.readFileSync(path.join(root, file))), hash);
  const official = fs.readFileSync(path.join(root, 'lib.js'), 'utf8').replace(/^\/\/ Dependency import adapted[^\n]*\n/, '').replace("import chalk from './chalk/source/index.js';", "import chalk from 'chalk';");
  assert.equal(sha(official), provenance.originalCoreSha256);
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Apache License/);
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /MIT License/);
  assert.match(fs.readFileSync(path.join(root, 'chalk/license'), 'utf8'), /MIT License/);
});

test('Sequential Thinking revision, branch, boolean strings and numeric coercion match official core with retained history', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-sequential-test-'));
  const gateway = new Gateway({ configFile: path.join(directory, 'config.json'), fetch: () => { throw new Error('no HTTP'); } });
  t.after(async () => { await gateway.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const { SequentialThinkingServer } = await import(pathToFileURL(path.join(__dirname, '../vendor/sequential-thinking/lib.js')).href);
  const official = new SequentialThinkingServer();
  official.disableThoughtLogging = true;
  const steps = [
    [{ thought: 'one', nextThoughtNeeded: 'TRUE', thoughtNumber: '1', totalThoughts: '3', ignored: 'stripped' }, { thought: 'one', nextThoughtNeeded: true, thoughtNumber: 1, totalThoughts: 3 }],
    [{ thought: 'revision', nextThoughtNeeded: 'false', thoughtNumber: 2, totalThoughts: 3, isRevision: 'true', revisesThought: '1' }, { thought: 'revision', nextThoughtNeeded: false, thoughtNumber: 2, totalThoughts: 3, isRevision: true, revisesThought: 1 }],
    [{ thought: 'branch', nextThoughtNeeded: true, thoughtNumber: 4, totalThoughts: 3, branchFromThought: '2', branchId: 'alternate', needsMoreThoughts: 'False', isRevision: 'false' }, { thought: 'branch', nextThoughtNeeded: true, thoughtNumber: 4, totalThoughts: 3, branchFromThought: 2, branchId: 'alternate', needsMoreThoughts: false, isRevision: false }],
    [{ thought: 'done', nextThoughtNeeded: false, thoughtNumber: 5, totalThoughts: 5 }, { thought: 'done', nextThoughtNeeded: false, thoughtNumber: 5, totalThoughts: 5 }]
  ];
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    for (let i = 0; i < steps.length; i++) {
      const [args, normalized] = steps[i];
      const snapshot = structuredClone(args);
      const expected = official.processThought(normalized);
      const result = await gateway.call({ name: 'sequentialthinking', arguments: args });
      assert.deepEqual(result, { content: expected.content, structuredContent: JSON.parse(expected.content[0].text) });
      assert.equal(result.structuredContent.thoughtHistoryLength, i + 1);
      assert.deepEqual(args, snapshot);
      if (i === 1) {
        const invalid = await gateway.call({ name: 'sequentialthinking', arguments: { thought: 'secret-invalid-input', nextThoughtNeeded: 'yes', thoughtNumber: 3, totalThoughts: 3 } });
        assert.equal(invalid.isError, true);
        assert.doesNotMatch(JSON.stringify(invalid), /secret-invalid-input|yes/);
      }
    }
    assert.deepEqual(logs, []);
    const core = gateway.local.get('sequentialthinking').transport.core;
    assert.deepEqual(core.thoughtHistory, official.thoughtHistory);
    assert.deepEqual(core.branches, official.branches);
    assert.deepEqual(core.branches.alternate.map(step => step.thoughtNumber), [4]);
  } finally { console.error = originalError; }
});
