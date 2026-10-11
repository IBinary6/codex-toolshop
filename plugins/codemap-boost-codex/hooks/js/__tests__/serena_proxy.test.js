'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const readline = require('node:readline');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SerenaMcpProxy } = require('../../../scripts/serena-proxy.cjs');
const { serenaRuntimePaths } = require('../lib/serena-runtime');

const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('fixture timeout'); await delay(); }
}

function fixture(extra = {}) {
  const input = new PassThrough(), output = new PassThrough(), stderr = new PassThrough();
  const messages = [], children = [], history = [], preparation = [], applied = [];
  readline.createInterface({ input: output }).on('line', (line) => messages.push(JSON.parse(line)));
  let generation = 'one', stopFailure = false;
  const launchBackend = () => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 5000 + children.length, exitCode: null, signalCode: null });
    child.reply = (message) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    child.exit = () => { child.exitCode = 0; child.emit('exit', 0); };
    child.project = null;
    children.push(child);
    readline.createInterface({ input: child.stdin }).on('line', (line) => {
      const message = JSON.parse(line); history.push({ child: child.pid, message });
      if (!message.method) { if (child.callback) { const held = child.callback; child.callback = null; child.reply({ id: held.id, result: { content: [{ type: 'text', text: 'callback completed' }] } }); } return; }
      if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
      if (extra.intercept && extra.intercept(child, message)) return;
      let result = {};
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'native-fixture', version: '1' }, instructions: 'original instructions' };
      if (message.method === 'tools/list') result = { tools: [{ name: child.project ? 'project_tool' : 'cold_tool', inputSchema: { type: 'object', properties: { nativeOnly: { type: 'boolean' } } } }] };
      if (message.method === 'tools/call') {
        const name = message.params.name;
        if (name === 'activate_project') {
          if (message.params.arguments.project === '/fail') { child.reply({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'activation failed' }] } }); return; }
          child.project = message.params.arguments.project;
          child.reply({ method: 'notifications/tools/list_changed' });
          result = { content: [{ type: 'text', text: 'native activation' }] };
        } else if (name === 'get_current_config') result = { content: [{ type: 'text', text: child.project ? `Current configuration:\nActive project: ${child.project.slice(1)}\n` : 'No active project' }] };
        else if (name === 'callback') {
          child.callback = message;
          child.reply({ id: message.id, method: 'sampling/createMessage', params: { messages: [] } }); return;
        } else if (name === 'held') { child.held = message; return; }
        else {
          if (message.params._meta) child.reply({ method: 'notifications/progress', params: { progressToken: message.params._meta.progressToken, progress: 7, total: 8 } });
          result = { structuredContent: { root: child.project }, content: [{ type: 'text', text: `symbol from ${child.project}` }] };
        }
      }
      child.reply({ id: message.id, result });
    });
    return child;
  };
  const proxy = new SerenaMcpProxy({ input, output, stderr, launchBackend,
    prepareProject: async (root) => { preparation.push(root); return { status: 'ready', generation, databaseDir: `/db/${generation}`, diagnostics: [] }; },
    resolveProject: async (project) => project ? { root: project.startsWith('/') ? project : `/${project}`, name: project.replace(/^\//, '') } : {},
    applySession: async (value) => { applied.push(value); return { ok: true }; },
    killTree: async (child) => { if (stopFailure) throw new Error('fixture stop failure'); child.exit(); },
    requestTimeoutMs: 1000, stopTimeoutMs: 100, ...extra.options,
  });
  const running = proxy.run();
  const send = (message) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const reply = async (id) => { await until(() => messages.some((m) => m.id === id && !m.method)); return messages.find((m) => m.id === id && !m.method); };
  const initialize = async (id = 42) => { send({ id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { sampling: {} }, clientInfo: { name: 'host', version: '2' } } }); await reply(id); send({ method: 'notifications/initialized' }); };
  const call = (id, name, args = {}, meta) => send({ id, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });
  const close = async () => { input.end(); assert.equal(await running, 0); };
  return { proxy, send, call, reply, initialize, close, children, history, messages, preparation, applied, stderr,
    generation: (value) => { generation = value; }, stopFailure: (value) => { stopFailure = value; } };
}

(async () => {
  {
    let attempts = 0;
    const f = fixture({ options: { stopBackend: async (context) => {
      attempts += 1;
      if (!context.exited) context.child.exit();
      throw new Error('owned language service cleanup not confirmed');
    } } });
    await f.initialize();
    f.call(1, 'activate_project', { project: '/A' });
    assert.match((await f.reply(1)).error.message, /cleanup not confirmed/);
    f.call(2, 'find_symbol');
    assert.match((await f.reply(2)).error.message, /cleanup not confirmed/);
    assert.equal(f.children.length, 1, 'root exit must not permit a second backend after owned LSP cleanup failure');
    assert.equal(f.applied.length, 0, 'uncertain cleanup must not rewrite the live session');
    assert.equal(attempts, 1, 'ordinary retry must not bypass a failed cleanup boundary');
    f.proxy.options.stopBackend = async () => {};
    await f.close();
  }

  {
    let confirmed = 0;
    const f = fixture({ options: { stopBackend: async (context) => {
      assert.equal(context.exited, true);
      confirmed += 1;
    } } });
    await f.initialize(); f.children[0].exit();
    f.call(1, 'find_symbol'); await f.reply(1);
    assert.equal(confirmed, 1, 'already-exited root still requires independent language service cleanup');
    f.children.at(-1).exit(); await f.close();
    assert.equal(confirmed, 2);
  }

  {
    const f = fixture({ options: { prepareProject: async (root) => ({ status: 'ready', generation: root === '/A' ? 'A-original' : 'B-other', databaseDir: root === '/A' ? '/db/A-original' : '/db/B-other', diagnostics: [] }) },
      intercept(child, message) {
        if (message.method === 'tools/call' && message.params.name === 'activate_project' && message.params.arguments.project === '/B') {
          child.reply({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'native backend mismatch' }] } }); return true;
        }
        return false;
      },
    });
    await f.initialize(); f.call(1, 'activate_project', { project: '/A' }); await f.reply(1);
    const generationA = f.proxy.generation;
    f.call(2, 'activate_project', { project: '/B' });
    const response = await f.reply(2);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, 'native backend mismatch', 'failed B native result is preserved');
    assert.equal(f.proxy.active.root, '/A');
    assert.equal(f.proxy.generation, generationA);
    assert.deepEqual(f.applied.map((item) => [item.root, item.preparation.databaseDir]), [['/A', '/db/A-original'], ['/B', '/db/B-other'], ['/A', '/db/A-original']]);
    const recovering = f.children.at(-1).pid;
    assert.ok(f.history.some((item) => item.child === recovering && item.message.method === 'tools/call' && item.message.params.name === 'activate_project' && item.message.params.arguments.project === '/A'));
    f.call(3, 'find_symbol'); assert.equal((await f.reply(3)).result.structuredContent.root, '/A');
    await f.close();
  }

  {
    const f = fixture({ intercept(child, message) {
      if (message.method === 'tools/call' && message.params.name === 'activate_project' && message.params.arguments.project === '/B') {
        child.reply({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'original B failure' }] } }); return true;
      }
      return false;
    } });
    await f.initialize(); f.call(1, 'activate_project', { project: '/A' }); await f.reply(1);
    const apply = f.proxy.options.applySession;
    f.proxy.options.applySession = async (value) => { if (value.root === '/A') throw new Error('restore fixture failure'); return apply(value); };
    f.call(2, 'activate_project', { project: '/B' });
    const response = await f.reply(2);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, 'original B failure');
    assert.match(response.result.content.at(-1).text, /Previous project recovery failed/);
    assert.equal(f.proxy.active, null, 'failed restoration never publishes A as active');
    await f.close();
  }

  {
    const nativeError = { code: -32001, message: 'original backend mismatch', data: ['native', { detail: 7 }] };
    const f = fixture({ intercept(child, message) {
      if (message.method === 'tools/call' && message.params.name === 'activate_project' && message.params.arguments.project === '/B') {
        child.reply({ id: message.id, error: nativeError }); return true;
      }
      return false;
    } });
    await f.initialize(); f.call(1, 'activate_project', { project: '/A' }); await f.reply(1);
    const apply = f.proxy.options.applySession;
    f.proxy.options.applySession = async (value) => { if (value.root === '/A') throw new Error('restore fixture failure'); return apply(value); };
    f.call(2, 'activate_project', { project: '/B' });
    assert.deepEqual((await f.reply(2)).error, nativeError, 'top-level native error code/message/data remain exact even when restoration fails');
    assert.equal(f.proxy.active, null);
    assert.match(f.stderr.read().toString(), /previous project recovery failed/, 'top-level error restoration failure remains visible in connection stderr');
    await f.close();
  }

  {
    let f;
    f = fixture({ intercept(child, message) {
      if (message.method === 'tools/call' && message.params.name === 'activate_project' && message.params.arguments.project === '/B') {
        f.stopFailure(true);
        child.reply({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'original B failure' }] } }); return true;
      }
      return false;
    } });
    await f.initialize(); f.call(1, 'activate_project', { project: '/A' }); await f.reply(1);
    f.call(2, 'activate_project', { project: '/B' });
    const response = await f.reply(2);
    assert.equal(response.result.content[0].text, 'original B failure');
    assert.match(response.result.content.at(-1).text, /Previous project recovery failed/);
    assert.equal(f.proxy.active, null);
    assert.equal(f.children.length, 3, 'failed B termination must not launch a concurrent recovery backend');
    f.stopFailure(false); await f.close();
  }

  {
    const f = fixture(); await f.initialize();
    f.call(1, 'activate_project', { project: '/A' }); await f.reply(1);
    const generationA = f.proxy.generation;
    let continuePreparation;
    const gate = new Promise((resolve) => { continuePreparation = resolve; });
    const apply = f.proxy.options.applySession;
    f.proxy.options.applySession = async (value) => { const result = await apply(value); if (value.root === '/B') await gate; return result; };
    f.call(2, 'activate_project', { project: '/B' });
    await until(() => f.applied.some((item) => item.root === '/B'));
    f.send({ method: 'notifications/cancelled', params: { requestId: 2 } });
    continuePreparation();
    await until(() => f.proxy.active?.root === '/A' && !f.proxy.requests.has(2));
    assert.equal(f.proxy.generation, generationA, 'preparation-stage cancellation restores original generation');
    assert.deepEqual(f.applied.map((item) => item.root), ['/A', '/B', '/A']);
    assert.ok(!f.history.some((item) => item.message.method === 'tools/call' && item.message.params.name === 'activate_project' && item.message.params.arguments.project === '/B'));
    assert.ok(!f.messages.some((message) => message.id === 2));
    f.call(3, 'find_symbol'); assert.equal((await f.reply(3)).result.structuredContent.root, '/A');
    await f.close();
  }

  {
    const f = fixture({ options: { resolveProject: async (project) => {
      if (project === 'A') throw new Error('ambiguous registered name');
      return { root: project, name: 'A', languages: ['cpp'] };
    } } });
    await f.initialize(); f.call(1, 'activate_project', { project: '/A' }); await f.reply(1);
    f.call(2, 'get_current_config');
    assert.ok(!(await f.reply(2)).error, 'name resolution failure must not replace successful native config result');
    assert.equal(f.proxy.active.root, '/A');
    assert.deepEqual(f.proxy.active.languages, ['cpp']);
    f.generation('two'); f.call(3, 'find_symbol');
    assert.equal((await f.reply(3)).result.structuredContent.root, '/A');
    assert.equal(f.preparation.at(-1), '/A', 'same-name config query preserves root for generation refresh');
    await f.close();
  }

  {
    const f = fixture({
      options: { resolveProject: async (project) => ['missing', '/not-existing-path'].includes(project) ? { root: null } : { root: project.startsWith('/') ? project : `/${project}`, name: project.replace(/^\//, ''), languages: ['cpp'] } },
      intercept(child, message) {
        if (message.method === 'tools/call' && message.params.name === 'activate_project' && ['missing', '/not-existing-path'].includes(message.params.arguments.project)) {
          child.reply({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'native project not found' }] } }); return true;
        }
        return false;
      },
    });
    await f.initialize(); f.call(1, 'activate_project', { project: '/A' }); await f.reply(1);
    const context = f.proxy.backend;
    f.call(2, 'activate_project', { project: 'missing' });
    assert.equal((await f.reply(2)).result.isError, true);
    assert.equal(f.proxy.backend, context, 'unresolved activation does not restart native backend');
    assert.equal(f.proxy.active.root, '/A', 'failed native unknown name retains re-confirmed original project');
    f.call(3, 'activate_project', { project: '/not-existing-path' });
    assert.equal((await f.reply(3)).result.isError, true);
    assert.equal(f.proxy.backend, context);
    assert.equal(f.proxy.active.root, '/A', 'failed nonexistent absolute path retains native original project');
    f.generation('two'); f.call(4, 'find_symbol');
    assert.equal((await f.reply(4)).result.structuredContent.root, '/A');
    assert.equal(f.preparation.at(-1), '/A');
    await f.close();
  }

  {
    const f = fixture({ options: { resolveProject: async (project) => ({ root: project.startsWith('/') ? project : `/${project}`, name: project.replace(/^\//, ''), languages: ['cpp'] }) } });
    await f.initialize(); f.call(1, 'activate_project', { project: '/A' }); await f.reply(1);
    f.children.at(-1).project = '/B';
    f.call(2, 'get_current_config'); await f.reply(2);
    assert.equal(f.proxy.active.root, '/B', 'changed native name resolves instead of retaining previous root');
    await f.close();
  }

  // The real helper uses official Serena to resolve two same-name projects; run with an installed runtime and explicitly skip in CI without one.
  const python = process.env.CODEMAP_SERENA_TEST_PYTHON || serenaRuntimePaths().python;
  if (fs.existsSync(python)) {
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'serena-same-name-')));
    const home = path.join(temporary, 'private-home');
    const roots = ['worktree-A', 'worktree-B'].map((name) => path.join(temporary, name));
    const mismatchedRoot = path.join(temporary, 'backend-mismatch-B');
    const projectYaml = 'project_name: SharedName\nlanguage_servers: [cpp]\n';
    try {
      fs.mkdirSync(home);
      for (const root of roots) {
        fs.mkdirSync(path.join(root, '.serena'), { recursive: true });
        fs.writeFileSync(path.join(root, '.serena', 'project.yml'), projectYaml);
      }
      fs.mkdirSync(path.join(mismatchedRoot, '.serena'), { recursive: true });
      const mismatchYaml = 'project_name: BackendMismatch\nlanguage_servers: [cpp]\nlanguage_backend: JetBrains\n';
      fs.writeFileSync(path.join(mismatchedRoot, '.serena', 'project.yml'), mismatchYaml);
      fs.writeFileSync(path.join(home, 'serena_config.yml'), JSON.stringify({ projects: [...roots, mismatchedRoot] }));
      const resolved = new Map();
      for (const project of [...roots, 'SharedName', mismatchedRoot]) {
        const result = spawnSync(python, ['-I', '-B', path.resolve(__dirname, '../../../scripts/serena-session.py')], {
          input: JSON.stringify({ command: 'resolve', home, project }), encoding: 'utf8', windowsHide: true,
          env: { ...process.env, SERENA_HOME: home }, timeout: 30000,
        });
        assert.equal(result.status, 0); assert.ok(!result.error);
        resolved.set(project, JSON.parse(result.stdout));
      }
      assert.equal(resolved.get('SharedName').ok, false, 'real native helper reports duplicate name ValueError');
      assert.match(resolved.get('SharedName').diagnostics[0], /ValueError/);
      assert.equal(resolved.get(mismatchedRoot).root, mismatchedRoot);
      assert.deepEqual(resolved.get(mismatchedRoot).languages, ['cpp'], 'valid backend-mismatch project resolves through real native helper');
      let nameResolutions = 0;
      const f = fixture({ options: {
        resolveProject: async (project) => { if (project === 'SharedName') nameResolutions += 1; return resolved.get(project) || {}; },
      }, intercept(child, message) {
        if (message.method === 'tools/call' && message.params.name === 'get_current_config') {
          child.reply({ id: message.id, result: { content: [{ type: 'text', text: child.project ? 'Active project: SharedName\n' : 'No active project' }] } }); return true;
        }
        if (message.method === 'tools/call' && message.params.name === 'activate_project' && message.params.arguments.project === 'SharedName') {
          child.reply({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'native ambiguous name' }] } }); return true;
        }
        return false;
      } });
      await f.initialize(); f.call(1, 'activate_project', { project: roots[0] }); await f.reply(1);
      f.call(2, 'get_current_config'); assert.ok(!(await f.reply(2)).error);
      assert.equal(f.proxy.active.root, roots[0]);
      assert.deepEqual(f.proxy.active.languages, ['cpp']);
      assert.equal(nameResolutions, 0, 'same native name reuses confirmed absolute root before ambiguous helper lookup');
      f.generation('macro-changed'); f.call(3, 'find_symbol');
      assert.equal((await f.reply(3)).result.structuredContent.root, roots[0]);
      assert.equal(f.preparation.at(-1), roots[0]);
      f.call(4, 'activate_project', { project: 'SharedName' });
      assert.equal((await f.reply(4)).result.isError, true);
      assert.equal(f.proxy.active.root, roots[0]);
      f.call(5, 'activate_project', { project: roots[1] }); await f.reply(5);
      assert.equal(f.proxy.active.root, roots[1], 'explicit second root switches correctly despite identical project name');
      f.call(6, 'get_current_config'); await f.reply(6);
      f.generation('second-macro-changed'); f.call(7, 'find_symbol');
      assert.equal((await f.reply(7)).result.structuredContent.root, roots[1]);
      assert.equal(f.preparation.at(-1), roots[1]);
      await f.close();
      const rollback = fixture({ options: {
        resolveProject: async (project) => resolved.get(project) || {},
        prepareProject: async (root) => ({ status: 'ready', generation: root === mismatchedRoot ? 'B-other' : 'A-original', databaseDir: root === mismatchedRoot ? '/db/B-other' : '/db/A-original', diagnostics: [] }),
      }, intercept(child, message) {
        if (message.method === 'tools/call' && message.params.name === 'get_current_config') {
          child.reply({ id: message.id, result: { content: [{ type: 'text', text: child.project ? 'Active project: SharedName\n' : 'No active project' }] } }); return true;
        }
        if (message.method === 'tools/call' && message.params.name === 'activate_project' && message.params.arguments.project === mismatchedRoot) {
          child.reply({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'requires JetBrains but session uses LSP' }] } }); return true;
        }
        return false;
      } });
      await rollback.initialize(); rollback.call(1, 'activate_project', { project: roots[0] }); await rollback.reply(1);
      const generationA = rollback.proxy.generation;
      rollback.call(2, 'activate_project', { project: mismatchedRoot });
      const failure = await rollback.reply(2);
      assert.equal(failure.result.isError, true);
      assert.equal(failure.result.content[0].text, 'requires JetBrains but session uses LSP');
      assert.equal(rollback.proxy.active.root, roots[0]);
      assert.equal(rollback.proxy.generation, generationA);
      assert.deepEqual(rollback.applied.map((item) => [item.root, item.preparation.databaseDir]), [[roots[0], '/db/A-original'], [mismatchedRoot, '/db/B-other'], [roots[0], '/db/A-original']]);
      rollback.call(3, 'find_symbol'); assert.equal((await rollback.reply(3)).result.structuredContent.root, roots[0]);
      await rollback.close();
      for (const root of roots) assert.equal(fs.readFileSync(path.join(root, '.serena', 'project.yml'), 'utf8'), projectYaml);
      assert.equal(fs.readFileSync(path.join(mismatchedRoot, '.serena', 'project.yml'), 'utf8'), mismatchYaml);
      console.log('serena_proxy real same-name helper fixture PASS');
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  } else console.log('serena_proxy real same-name helper fixture SKIP (private Serena runtime not installed)');

  for (const initializeId of [17, 'arbitrary-string-id']) {
    const f = fixture();
    await f.initialize(initializeId);
    const init = await f.reply(initializeId);
    assert.equal(init.result.serverInfo.name, 'native-fixture');
    assert.equal(init.result.instructions, 'original instructions');
    f.send({ id: 1, method: 'tools/list' });
    assert.equal((await f.reply(1)).result.tools[0].name, 'cold_tool');
    f.call(2, 'activate_project', { project: '/A' });
    f.call(3, 'find_symbol', {}, { progressToken: 'host-token' });
    await f.reply(2);
    assert.equal((await f.reply(3)).result.structuredContent.root, '/A', 'concurrent read must follow confirmed activation');
    f.send({ id: 4, method: 'tools/list' });
    const tools = (await f.reply(4)).result.tools;
    assert.equal(tools[0].name, 'project_tool');
    assert.equal(tools[0].inputSchema.properties.nativeOnly.type, 'boolean');
    assert.ok(f.messages.some((message) => message.method === 'notifications/tools/list_changed'));
    assert.ok(f.messages.some((message) => message.method === 'notifications/progress' && message.params.progressToken === 'host-token' && message.params.progress === 7));
    f.generation('two');
    f.call(5, 'find_symbol');
    assert.equal((await f.reply(5)).result.structuredContent.root, '/A');
    assert.equal(f.children.length, 3, 'initial generation and changed generation rebuild only once each');
    const last = f.children.at(-1).pid;
    assert.equal(f.history.filter((item) => item.child === last && item.message.method === 'initialize').length, 1);
    assert.ok(f.history.some((item) => item.child === last && item.message.method === 'notifications/initialized'));
    await f.close();
    assert.ok(f.children.every((child) => child.exitCode === 0), 'EOF cleans owned children');
  }

  {
    const f = fixture(); await f.initialize();
    f.call(1, 'callback');
    await until(() => f.messages.some((message) => message.method === 'sampling/createMessage'));
    const callback = f.messages.find((message) => message.method === 'sampling/createMessage');
    f.call(2, 'activate_project', { project: '/B' });
    await delay(30); assert.equal(f.preparation.length, 0, 'queued activation waits for callback-dependent request');
    f.send({ id: callback.id, result: { role: 'assistant', content: { type: 'text', text: 'sample' }, model: 'fixture' } });
    await f.reply(1); await f.reply(2);
    const original = f.history.find((item) => !item.message.method && item.message.result?.model === 'fixture');
    assert.ok(original); assert.notEqual(original.message.id, callback.id, 'callback ID is mapped in its own namespace');
    await f.close();
  }

  {
    const f = fixture(); await f.initialize();
    f.call(1, 'held'); await until(() => f.children[0].held);
    const held = f.children[0].held;
    f.send({ method: 'notifications/cancelled', params: { requestId: 1, reason: 'host cancelled' } });
    f.call(2, 'activate_project', { project: '/B' });
    await delay(30); assert.equal(f.children.length, 1, 'cancel does not imply request completion');
    assert.ok(f.history.some((item) => item.message.method === 'notifications/cancelled' && item.message.params.requestId === held.id));
    f.children[0].reply({ id: held.id, result: { content: [] } });
    await f.reply(2); assert.ok(!f.messages.some((message) => message.id === 1));
    await f.close();
  }

  {
    const f = fixture(); await f.initialize();
    f.call(1, 'activate_project', { project: '/fail' });
    assert.equal((await f.reply(1)).result.isError, true);
    assert.equal(f.proxy.active, null, 'isError activation must not confirm active');
    const count = f.preparation.length;
    f.call(2, 'find_symbol'); await f.reply(2);
    assert.equal(f.preparation.length, count, 'unconfirmed project never prepares using cwd');
    f.stopFailure(true); f.generation('two');
    f.call(3, 'activate_project', { project: '/B' });
    assert.match((await f.reply(3)).error.message, /stop failure/);
    assert.equal(f.children.length, 2, 'stop failure forbids second live backend');
    f.stopFailure(false); await f.close();
  }

  {
    const f = fixture(); await f.initialize();
    f.call(1, 'activate_project', { project: '/A' }); await f.reply(1);
    f.call(2, 'activate_project', { project: '/B' }); await f.reply(2);
    const last = f.children.at(-1).pid;
    const activations = f.history.filter((item) => item.child === last && item.message.method === 'tools/call' && item.message.params.name === 'activate_project');
    assert.deepEqual(activations.map((item) => item.message.params.arguments.project), ['/B'], 'switching to B never replays A using B compilation parameters');
    await f.close();
  }

  {
    const f = fixture({ options: { resolveProject: async (project) => ({ root: project.startsWith('/') ? project : `/${project}`, name: project.replace(/^\//, ''), languages: ['typescript'] }) } });
    await f.initialize(); f.call(1, 'activate_project', { project: '/TS' });
    const activation = await f.reply(1);
    f.call(2, 'find_symbol'); const symbol = await f.reply(2);
    assert.equal(f.preparation.length, 0, 'non-C++ semantic calls bypass C++ exporter');
    assert.equal(f.applied[0].preparation.status, 'not_applicable', 'non-C++ activation restores baseline C++ settings');
    assert.equal(activation.result.content.length, 1);
    assert.equal(symbol.result.content.length, 1, 'non-C++ result has no C++ readiness warning');
    await f.close();
  }

  {
    const f = fixture({ options: {
      resolveProject: async (project) => ({ root: '/TS', name: project.startsWith('/') ? null : 'TS', languages: project.startsWith('/') ? null : ['typescript'] }),
      prepareProject: async () => ({ status: 'unsupported', diagnostics: [{ code: 'NO_CPP', message: 'no cpp configuration' }] }),
    } });
    await f.initialize(); f.call(1, 'activate_project', { project: '/TS' });
    const response = await f.reply(1);
    assert.equal(f.proxy.active.languages[0], 'typescript');
    assert.equal(response.result.content.length, 1, 'first activation of a configless non-C++ project suppresses C++ warning after native detection');
    f.call(2, 'find_symbol');
    assert.equal((await f.reply(2)).result.content.length, 1);
    await f.close();
  }

  {
    const f = fixture({ intercept(child, message) {
      if (message.method === 'tools/call' && message.params.name === 'get_current_config') {
        child.reply({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'confirmation failed' }] } }); return true;
      }
      return false;
    } });
    await f.initialize(); f.call(1, 'activate_project', { project: '/A' });
    assert.equal((await f.reply(1)).result.content[0].text, 'native activation');
    assert.equal(f.proxy.active, null, 'native confirmation isError cannot confirm active');
    await f.close();
  }

  {
    const f = fixture(); await f.initialize();
    f.send({ id: 11, method: 'logging/setLevel', params: { level: 'debug' } }); await f.reply(11);
    f.call(1, 'activate_project', { project: '/A' }); await f.reply(1);
    f.children.at(-1).exit();
    f.call(2, 'find_symbol');
    assert.equal((await f.reply(2)).result.structuredContent.root, '/A', 'unexpected owned backend exit replays session before request');
    const last = f.children.at(-1).pid;
    assert.ok(f.history.some((item) => item.child === last && item.message.method === 'logging/setLevel' && item.message.params.level === 'debug'));
    await f.close();
  }

  {
    const f = fixture({ options: { requestTimeoutMs: 50 } }); await f.initialize();
    f.call(1, 'held'); const timeout = await f.reply(1);
    assert.match(timeout.error.message, /timeout/);
    f.call(2, 'activate_project', { project: '/A' });
    await delay(80); assert.equal(f.preparation.length, 0, 'timeout cannot release in-flight tool serialization');
    f.children[0].reply({ id: f.children[0].held.id, result: { content: [] } });
    await f.reply(2); await f.close();
  }

  {
    const f = fixture({ options: { prepareProject: async () => ({ status: 'failed', diagnostics: ['safe failure'] }) } });
    await f.initialize(); f.call(1, 'activate_project', { project: '/A' });
    const activation = await f.reply(1);
    assert.match(activation.result.content.at(-1).text, /failed.*semantic readiness is unverified/s);
    assert.equal(f.proxy.active.root, '/A', 'native limited activation remains available');
    await f.close();
  }
  {
    const f = fixture({ options: { prepareProject: async () => ({ status: 'failed', diagnostics: [{ code: 'NO_DB', message: 'safe diagnostic' }] }) } });
    await f.initialize(); f.call(1, 'activate_project', { project: '/A' });
    const response = await f.reply(1);
    assert.match(response.result.content.at(-1).text, /NO_DB: safe diagnostic/);
    assert.ok(!response.result.content.at(-1).text.includes('[object Object]'));
    await f.close();
  }
  console.log('serena_proxy.test.js PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
