'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { CommandClient, ctx7Args, CTX7_VERSION, MAX, readJson, runProcess, findNpm } = require('../scripts/command-client.cjs');
const { PROFILES, createConfig } = require('../scripts/config.cjs');
const { generate } = require('../packaging/generate.cjs');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-command-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function client(t, provider, options = {}) {
  const directory = options.directory || temporary(t);
  const env = { ...options.env, CODEX_HOME: directory };
  delete env[PROFILES[provider].override];
  const file = path.join(directory, PROFILES[provider].name, 'config.json');
  createConfig(file, provider);
  fs.writeFileSync(file, JSON.stringify({ version: 1, apiKey: 'synthetic-private-key' }));
  const result = new CommandClient(provider, { ...options, env, configFile: file });
  t.after(() => result.close());
  return { client: result, directory, file };
}

const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('test fixtures force temporary config/runtime even when options contain host-looking environment overrides', t => {
  const directory = temporary(t);
  const forbidden = path.join(directory, 'must-not-touch/config.json');
  const { client: exa, file } = client(t, 'exa', { directory, configFile: forbidden, env: { CODEX_HOME: path.join(directory, 'must-not-touch'), EXA_CODEX_CONFIG: forbidden } });
  assert.equal(exa.env.CODEX_HOME, directory);
  assert.equal(exa.env.EXA_CODEX_CONFIG, undefined);
  assert.equal(exa.file, path.join(directory, 'exa-codex/config.json'));
  assert.equal(file, exa.file);
  assert.equal(fs.existsSync(path.join(directory, 'must-not-touch')), false);
});

test('direct Exa REST preserves search objective, contents nesting and official result/status/pagination fields', async t => {
  const calls = [];
  const result = { requestId: 'id', results: [{ url: 'https://example.com', text: 'page' }], statuses: [{ status: 'success' }], nextCursor: 'official-cursor' };
  const { client: exa } = client(t, 'exa', { fetch: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return response(result); } });
  const args = { query: 'q'.repeat(4100), numResults: 2 };
  const search = await exa.call({ name: 'web_search_exa', arguments: args });
  assert.deepEqual(search.structuredContent, result);
  assert.deepEqual(args, { query: 'q'.repeat(4100), numResults: 2 });
  assert.equal(calls[0].url, 'https://api.exa.ai/search');
  assert.equal(calls[0].init.headers['x-api-key'], 'synthetic-private-key');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(calls[0].body, { ...args, objective: 'q'.repeat(4096), contents: { highlights: true } });
  await exa.call({ name: 'web_search_exa', arguments: { query: 'unchanged', objective: 'specific objective' } });
  assert.deepEqual(calls[1].body, { query: 'unchanged', objective: 'specific objective', contents: { highlights: true } });
  await exa.call({ name: 'web_fetch_exa', arguments: { urls: ['https://example.com'], maxCharacters: 99 } });
  assert.equal(calls[2].url, 'https://api.exa.ai/contents');
  assert.deepEqual(calls[2].body, { ids: ['https://example.com'], text: { maxCharacters: 99 } });
  await exa.call({ name: 'web_fetch_exa', arguments: { urls: ['https://example.com'] } });
  assert.equal(calls[3].body.text.maxCharacters, 3000);
  assert.equal(calls.length, 4, 'no automatic pagination or replay');
});

test('Exa maps only published category tokens to REST category and preserves objective and ordinary query text', async t => {
  const bodies = [];
  const { client: exa } = client(t, 'exa', { fetch: async (_, init) => { bodies.push(JSON.parse(init.body)); return response({ results: [] }); } });
  const cases = [
    [{ query: 'category:people engineer', numResults: 1 }, { query: 'engineer', numResults: 1, category: 'people', objective: 'category:people engineer', contents: { highlights: true } }],
    [{ query: 'biotech category:company Europe', objective: 'explicit goal' }, { query: 'biotech Europe', category: 'company', objective: 'explicit goal', contents: { highlights: true } }],
    [{ query: 'ordinary  spacing category:news category:companyish' }, { query: 'ordinary  spacing category:news category:companyish', objective: 'ordinary  spacing category:news category:companyish', contents: { highlights: true } }]
  ];
  for (const [args, expected] of cases) {
    const original = structuredClone(args);
    await exa.call({ name: 'web_search_exa', arguments: args });
    assert.deepEqual(bodies.at(-1), expected);
    assert.deepEqual(args, original);
  }
});

test('four Tavily direct REST aliases preserve arguments and use only Bearer authentication', async t => {
  const calls = [];
  const { client: tavily } = client(t, 'tavily', { fetch: async (url, init) => { calls.push({ url, init }); return response({ results: ['official'], next_cursor: 'cursor' }); } });
  const argumentsByName = { search: { query: 'query', max_results: 2, include_raw_content: true }, extract: { urls: ['https://example.com'], format: 'markdown' }, crawl: { url: 'https://example.com', max_depth: 1, limit: 2 }, map: { url: 'https://example.com', select_paths: ['/docs/.*'], allow_external: false } };
  for (const [name, args] of Object.entries(argumentsByName)) {
    const result = await tavily.call({ name: `tavily_${name}`, arguments: args });
    const call = calls.at(-1);
    assert.equal(call.url, `https://api.tavily.com/${name}`);
    assert.deepEqual(JSON.parse(call.init.body), args);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Bearer synthetic-private-key');
    assert.equal(call.init.body.includes('synthetic-private-key'), false);
    assert.deepEqual(result.structuredContent, { results: ['official'], next_cursor: 'cursor' });
  }
  assert.equal(calls.length, 4);
});

test('Tavily research creates once, polls GET through pending states and preserves completed sources', async t => {
  const calls = [];
  const results = [{ request_id: 'job-1', status: 'pending' }, { request_id: 'job-1', status: 'in_progress' }, { request_id: 'job-1', status: 'completed', content: 'report', sources: [{ url: 'https://example.com' }], usage: { credits: 1 } }];
  const { client: tavily } = client(t, 'tavily', { pollMs: 1, fetch: async (url, init) => { calls.push({ url, init }); return response(results[calls.length - 1]); } });
  const result = await tavily.call({ name: 'tavily_research', arguments: { input: 'bounded task', model: 'mini' } });
  assert.deepEqual(result.structuredContent, results[2]);
  assert.deepEqual(calls.map(call => call.init.method), ['POST', 'GET', 'GET']);
  assert.deepEqual(JSON.parse(calls[0].init.body), { input: 'bounded task', model: 'mini', stream: false });
  for (const call of calls.slice(1)) { assert.equal(call.url, 'https://api.tavily.com/research/job-1'); assert.equal(call.init.body, undefined); }
});

test('research create-only and resume never duplicate POST, report failed jobs and reject invalid controls', async t => {
  const calls = [];
  const { client: tavily } = client(t, 'tavily', { pollMs: 1, fetch: async (url, init) => { calls.push({ url, init }); return response({ request_id: 'job-2', status: init.method === 'POST' ? 'pending' : 'failed', error: 'official failure' }); } });
  const created = await tavily.call({ name: 'tavily_research', arguments: { input: 'task' }, research: { wait: false } });
  assert.equal(created.structuredContent.request_id, 'job-2');
  assert.equal(calls.length, 1);
  const resumed = await tavily.call({ name: 'tavily_research', arguments: {}, research: { requestId: 'job-2' } });
  assert.equal(resumed.isError, true);
  assert.equal(calls[1].init.method, 'GET');
  for (const research of [{ requestId: '../escape' }, { requestId: 0 }, { wait: 'false' }, []]) await assert.rejects(tavily.call({ name: 'tavily_research', arguments: {}, research }), /research|requestId/);
  assert.equal(calls.length, 2);
});

test('research timeout returns request_id for safe GET resume and releases polling listeners', async t => {
  let posts = 0, gets = 0;
  const { client: tavily } = client(t, 'tavily', { timeoutMs: 30, pollMs: 2, fetch: async (url, init) => { if (init.method === 'POST') posts++; else gets++; return response({ request_id: 'job-3', status: 'pending' }); } });
  const result = await tavily.call({ name: 'tavily_research', arguments: { input: 'task' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.request_id, 'job-3');
  assert.equal(result.structuredContent.status, 'pending');
  assert.equal(result.structuredContent.resume, true);
  assert.match(result.structuredContent.error, /cancelled|timed out/);
  assert.equal(posts, 1);
  assert.ok(gets > 0);
  assert.equal(tavily.controllers.size, 0);
});

test('every research polling failure retains a safe recovery ID and GET resume never repeats creation', async t => {
  const variants = [
    () => new Response('synthetic-private-key body', { status: 500 }),
    () => { throw new Error('synthetic-private-key network'); },
    () => new Response('synthetic-private-key invalid JSON'),
    () => response({ status: 'unknown', error: 'synthetic-private-key detail' }),
    () => response(null)
  ];
  for (const fail of variants) {
    const methods = [];
    let failed = false;
    const { client: tavily } = client(t, 'tavily', { pollMs: 1, fetch: async (url, init) => {
      methods.push(init.method);
      if (init.method === 'POST') return response({ request_id: 'recover-job', status: 'pending' });
      assert.equal(url, 'https://api.tavily.com/research/recover-job');
      if (!failed) { failed = true; return fail(); }
      return response({ request_id: 'recover-job', status: 'completed', content: 'safe report' });
    } });
    const result = await tavily.call({ name: 'tavily_research', arguments: { input: 'task' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.request_id, 'recover-job');
    assert.equal(result.structuredContent.resume, true);
    assert.equal(typeof result.structuredContent.error, 'string');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-key|network|detail/);
    assert.deepEqual(methods, ['POST', 'GET']);
    const resumed = await tavily.call({ name: 'tavily_research', arguments: {}, research: { requestId: result.structuredContent.request_id } });
    assert.equal(resumed.structuredContent.status, 'completed');
    assert.deepEqual(methods, ['POST', 'GET', 'GET']);
    assert.equal(tavily.controllers.size, 0);
  }
});

test('research cancellation retains only a previously validated ID, never a malformed creation response', async t => {
  const caller = new AbortController();
  const { client: tavily } = client(t, 'tavily', { pollMs: 1, fetch: async (_, init) => {
    if (init.method === 'POST') return response({ request_id: 'cancel-job', status: 'pending' });
    caller.abort();
    return new Promise(() => {});
  } });
  const result = await tavily.call({ name: 'tavily_research', arguments: { input: 'task' } }, caller.signal);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.request_id, 'cancel-job');
  assert.equal(result.structuredContent.resume, true);
  for (const request_id of ['../invalid', '', undefined, 23]) {
    const { client: invalid } = client(t, 'tavily', { fetch: async () => response({ request_id, status: 'pending' }) });
    await assert.rejects(invalid.call({ name: 'tavily_research', arguments: { input: 'task' } }), /valid request_id/);
  }
});

test('actual public Tavily CLI emits recovery JSON, fails visibly, and resumes by GET only', t => {
  const directory = temporary(t);
  generate({ outputRoot: directory });
  const file = path.join(directory, 'private/config.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ version: 1, apiKey: 'synthetic-private-key' }));
  const preload = path.join(directory, 'mock-fetch.cjs');
  const trace = path.join(directory, 'methods.jsonl');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const timer = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 2000 ? 1 : ms, ...args);
    globalThis.fetch = async (url, init) => {
      fs.appendFileSync(process.env.TRACE, JSON.stringify({ url, method: init.method }) + '\\n');
      if (init.method === 'POST') return new Response(JSON.stringify({ request_id: process.env.CASE === 'invalid' ? '../bad' : 'public-job', status: 'pending' }));
      if (process.env.CASE === 'http') return new Response('synthetic-private-key private body', { status: 500 });
      if (process.env.CASE === 'network') throw new Error('synthetic-private-key network');
      if (process.env.CASE === 'json') return new Response('synthetic-private-key invalid JSON');
      if (process.env.CASE === 'unknown') return new Response(JSON.stringify({ status: 'unknown' }));
      if (process.env.CASE === 'timeout') return new Promise(() => {});
      return new Response(JSON.stringify({ request_id: 'public-job', status: 'completed' }));
    };
  `);
  const run = (variant, params) => spawnSync(process.execPath, ['--require', preload, path.join(directory, 'tavily-codex/scripts/command.cjs')], {
    cwd: directory, env: { ...process.env, CODEX_HOME: directory, TAVILY_CODEX_CONFIG: file, CASE: variant, TRACE: trace, RESEARCH_TOOLS_TIMEOUT_MS: '1000' },
    input: JSON.stringify(params), encoding: 'utf8', timeout: 5000, windowsHide: true
  });
  for (const variant of ['http', 'network', 'json', 'unknown', 'timeout', 'invalid']) {
    const result = run(variant, { name: 'tavily_research', arguments: { input: 'task' } });
    assert.equal(result.status, 1, variant);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /synthetic-private-key|private body|network/);
    const value = JSON.parse(result.stdout);
    assert.equal(value.isError, true);
    if (variant === 'invalid') assert.equal(value.structuredContent, undefined);
    else {
      assert.equal(value.structuredContent.request_id, 'public-job', variant);
      assert.equal(value.structuredContent.resume, true);
      const resumed = run('completed', { name: 'tavily_research', arguments: {}, research: { requestId: value.structuredContent.request_id } });
      assert.equal(resumed.status, 0);
      assert.equal(JSON.parse(resumed.stdout).structuredContent.status, 'completed');
    }
  }
  const records = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(record => record.method === 'POST').length, 6);
  assert.equal(records.filter(record => record.method === 'GET').length, 10);
  for (const record of records.filter(record => record.method === 'GET')) assert.equal(record.url, 'https://api.tavily.com/research/public-job');
});

test('one-shot clients reread only private provider keys and redact echoed keys in every result field', async t => {
  const directory = temporary(t);
  const seen = [];
  const { client: exa, file } = client(t, 'exa', { directory, env: { RESEARCH_TOOLS_CONFIG: path.join(directory, 'must-not-read.json'), EXA_API_KEY: 'ambient-not-used' }, fetch: async (_, init) => { const key = init.headers['x-api-key']; seen.push(key); return response({ [key]: key, nested: [encodeURIComponent(key)], urls: [new URLSearchParams({ k: key }).toString()] }); } });
  await exa.call({ name: 'web_search_exa', arguments: { query: 'q' } });
  const rotated = 'rotated secret+/value';
  fs.writeFileSync(file, JSON.stringify({ version: 1, apiKey: rotated }));
  const result = await exa.call({ name: 'web_search_exa', arguments: { query: 'q' } });
  assert.deepEqual(seen, ['synthetic-private-key', rotated]);
  assert.equal(JSON.stringify(result).includes(rotated), false);
  assert.deepEqual(result.structuredContent, { '[REDACTED]': '[REDACTED]', nested: ['[REDACTED]'], urls: ['k=[REDACTED]'] });
  assert.equal(fs.existsSync(path.join(directory, 'must-not-read.json')), false);
});

test('direct failures are safe and bounded: HTTP/transport/JSON/oversize never leak body or retry', async t => {
  let calls = 0;
  const variants = [() => new Response('synthetic-private-key private body', { status: 401 }), () => { throw new Error('synthetic-private-key transport'); }, () => new Response('synthetic-private-key not JSON'), () => new Response('x'.repeat(MAX + 1))];
  const { client: exa } = client(t, 'exa', { fetch: async () => { calls++; return variants.shift()(); } });
  for (let i = 0; i < 4; i++) await assert.rejects(exa.call({ name: 'web_search_exa', arguments: { query: 'q' } }), error => { assert.doesNotMatch(error.message, /synthetic-private-key|private body|transport/); return true; });
  assert.equal(calls, 4);
  assert.equal(exa.controllers.size, 0);
});

test('direct timeout, caller cancellation and close stop hanging fetch/reader and allow later calls', async t => {
  let hanging = true, aborted = 0;
  const { client: exa } = client(t, 'exa', { timeoutMs: 20, fetch: async (_, init) => {
    if (!hanging) return response({ results: ['later'] });
    init.signal.addEventListener('abort', () => aborted++, { once: true });
    return new Promise(() => {});
  } });
  await assert.rejects(exa.call({ name: 'web_search_exa', arguments: { query: 'q' } }), /cancelled|timed out/);
  const caller = new AbortController();
  const pending = exa.call({ name: 'web_search_exa', arguments: { query: 'q' } }, caller.signal);
  caller.abort();
  await assert.rejects(pending, /cancelled|timed out/);
  const closed = exa.call({ name: 'web_search_exa', arguments: { query: 'q' } });
  exa.close();
  await assert.rejects(closed, /cancelled|timed out/);
  assert.equal(aborted, 3);
  assert.equal(exa.controllers.size, 0);
  hanging = false;
  assert.deepEqual((await exa.call({ name: 'web_search_exa', arguments: { query: 'q' } })).structuredContent, { results: ['later'] });
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const signal = new AbortController();
  const reading = readJson(new Response(stream), signal.signal);
  signal.abort();
  await assert.rejects(reading, /cancelled|timed out/);
  assert.equal(cancelled, true);
});

test('Context7 delegates fixed official CLI aliases/JSON/language without shell query parsing', () => {
  assert.deepEqual(ctx7Args('resolve-library-id', { libraryName: '-library', query: 'quote" $(text)' }), ['library', '--json', '--', '-library', 'quote" $(text)']);
  assert.deepEqual(ctx7Args('query-docs', { libraryId: '/org/project', query: 'query', language: 'Ruby' }), ['docs', '--json', '--language', 'Ruby', '--', '/org/project', 'query']);
  assert.equal(CTX7_VERSION, '0.6.0');
});

test('Context7 first actual call prepares only pinned private runtime, isolates credentials and supplies key only to official query', async t => {
  const invocations = [];
  const { client: ctx, directory, file } = client(t, 'context7', { env: { CONTEXT7_API_KEY: 'ambient-secret' }, findNpm: () => '/synthetic/npm-cli.js', runProcess: async (node, args, options) => { invocations.push({ node, args, options }); return args.includes('install') ? '' : JSON.stringify({ results: [{ id: '/org/project' }] }); } });
  const result = await ctx.call({ name: 'resolve-library-id', arguments: { libraryName: 'lib', query: 'q' } });
  assert.deepEqual(result.structuredContent, { results: [{ id: '/org/project' }] });
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].args, ['/synthetic/npm-cli.js', 'install', '--prefix', path.join(directory, 'context7-codex/runtime/official-cli'), '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', 'ctx7@0.6.0']);
  assert.equal(invocations[0].options.env.CONTEXT7_API_KEY, '');
  const env = invocations[1].options.env;
  assert.equal(env.CONTEXT7_API_KEY, 'synthetic-private-key');
  assert.equal(env.CTX7_TELEMETRY_DISABLED, '1');
  assert.equal(env.XDG_CONFIG_HOME, path.join(directory, 'context7-codex/runtime/config'));
  assert.equal(env.XDG_STATE_HOME, path.join(directory, 'context7-codex/runtime/state'));
  assert.equal(env.XDG_CACHE_HOME, path.join(directory, 'context7-codex/runtime/cache'));
  const credentials = path.join(env.XDG_CONFIG_HOME, 'context7/credentials.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(credentials, 'utf8')), {});
  const bytes = fs.readFileSync(credentials);
  const root = path.join(directory, 'context7-codex/runtime/official-cli/node_modules/ctx7');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.6.0' }));
  fs.writeFileSync(path.join(root, 'dist/index.js'), '// synthetic ready official entry');
  fs.writeFileSync(file, JSON.stringify({ version: 1, apiKey: '' }));
  await ctx.call({ name: 'query-docs', arguments: { libraryId: '/org/project', query: 'q', language: 'Ruby' } });
  assert.equal(invocations.length, 3, 'warm use does not start npm');
  assert.equal(invocations[2].options.env.CONTEXT7_API_KEY, '', 'anonymous never inherits ambient key');
  assert.deepEqual(fs.readFileSync(credentials), bytes, 'wx never replaces isolated credentials');
  assert.deepEqual(invocations[2].args.slice(1), ['docs', '--json', '--language', 'Ruby', '--', '/org/project', 'q']);
});

test('portable npm locator resolves actual JS entry and missing npm gives safe actionable error', t => {
  const directory = temporary(t);
  const node = path.join(directory, 'bundled-node/node.exe');
  const npm = path.join(directory, 'npm-runtime/node_modules/npm/bin/npm-cli.js');
  fs.mkdirSync(path.dirname(npm), { recursive: true });
  fs.writeFileSync(npm, '// synthetic npm');
  assert.equal(findNpm({ PATH: path.dirname(path.dirname(path.dirname(path.dirname(npm)))) }, node), fs.realpathSync(npm));
  assert.throws(() => findNpm({ PATH: '' }, node), /npm.*22\.13/);
});

test('real one-shot subprocess preserves split UTF8, discards stderr and terminates its owned child on cancellation', async () => {
  const controller = new AbortController();
  const text = await runProcess(process.execPath, ['-e', 'const b=Buffer.from("\u4e2d\u6587");process.stderr.write("secret stderr");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10)'], { signal: controller.signal, env: process.env });
  assert.equal(text, '\u4e2d\u6587');
  const pending = runProcess(process.execPath, ['-e', 'process.stderr.write("private");setInterval(()=>{},1000)'], { signal: controller.signal, env: process.env });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /cancelled|timed out/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stderr.write("private");process.exit(2)'], { signal: new AbortController().signal, env: process.env }), /official Context7 command failed/);
});

test('actual isolated CLI entry reads stdin and input-file, exits after REST mock and emits one safe JSON', t => {
  const directory = temporary(t);
  const standalone = path.join(directory, 'only-exa');
  fs.cpSync(path.join(__dirname, '../../exa-codex'), standalone, { recursive: true });
  const guard = path.join(directory, 'guard.cjs');
  fs.writeFileSync(guard, `require('node:child_process').spawn=()=>{throw new Error('REST must not spawn')};global.fetch=async(url,init)=>{if(url!=='https://api.exa.ai/search'||JSON.parse(init.body).objective!=='q'||init.headers['x-api-key']!=='synthetic-private-key')throw new Error('incorrect request');return new Response(JSON.stringify({results:[{url:'https://example.com'}]}));};`);
  const file = path.join(directory, 'exa.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, apiKey: 'synthetic-private-key' }));
  const env = { ...process.env, CODEX_HOME: directory, EXA_CODEX_CONFIG: file };
  const input = JSON.stringify({ name: 'web_search_exa', arguments: { query: 'q' } });
  const inputFile = path.join(directory, 'input.json');
  fs.writeFileSync(inputFile, '\uFEFF' + input);
  for (const args of [[], ['--input-file', inputFile]]) {
    const run = spawnSync(process.execPath, ['--require', guard, path.join(standalone, 'scripts/command.cjs'), ...args], { cwd: directory, env, input, encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(run.status, 0);
    assert.equal(run.stderr, '');
    assert.equal(run.stdout.trim().split('\n').length, 1);
    assert.deepEqual(JSON.parse(run.stdout).structuredContent, { results: [{ url: 'https://example.com' }] });
    assert.doesNotMatch(run.stdout, /synthetic-private-key/);
  }
  for (const input of ['{"invalid":', JSON.stringify({ name: 'web_search_exa', arguments: { query: 'q', apiKey: 'synthetic-private-key' } }), 'x'.repeat(MAX + 1)]) {
    const run = spawnSync(process.execPath, [path.join(standalone, 'scripts/command.cjs')], { env, input, encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, '');
    assert.equal(JSON.parse(run.stdout).isError, true);
    assert.doesNotMatch(run.stdout, /synthetic-private-key/);
  }
});

test('generator deletes only obsolete marker-owned unedited files, refuses changed obsolete files and all symlinks', t => {
  const directory = temporary(t);
  generate({ outputRoot: directory });
  const root = path.join(directory, 'exa-codex');
  const obsolete = path.join(root, '.mcp.json');
  const bytes = Buffer.from('{"old":"generated"}');
  fs.writeFileSync(obsolete, bytes);
  const marker = path.join(root, '.generated.json');
  const state = JSON.parse(fs.readFileSync(marker, 'utf8'));
  state.files['.mcp.json'] = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(marker, JSON.stringify(state));
  assert.throws(() => generate({ outputRoot: directory, check: true }), /differs|obsolete/);
  fs.writeFileSync(obsolete, 'manual edit');
  assert.throws(() => generate({ outputRoot: directory }), /deletion stopped/);
  assert.equal(fs.readFileSync(obsolete, 'utf8'), 'manual edit');
  fs.writeFileSync(obsolete, bytes);
  generate({ outputRoot: directory });
  assert.equal(fs.existsSync(obsolete), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(marker)).files, '.mcp.json'), false);
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => generate({ outputRoot: directory }), /symlink/);
  assert.equal(fs.existsSync(outside), true);
});
