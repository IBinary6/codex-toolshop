'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Gateway } = require('../scripts/gateway.cjs');
const { parseArgs } = require('../scripts/server.cjs');
const { providers, plans, generate } = require('../packaging/generate.cjs');
const catalog = require('../scripts/catalog.json');
const { PROFILES, configPath, template, createConfig, readConfig } = require('../scripts/config.cjs');

function temporary(t) {
  // Node resolves module paths to real paths, so isolation checks must use a canonical temporary root.
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'research-packages-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('provider filter exposes exactly its own tools and rejects all foreign calls without transport', async t => {
  const directory = temporary(t);
  let transports = 0;
  for (const provider of providers) {
    const file = path.join(directory, provider.name, 'config.json');
    const gateway = new Gateway({ provider: provider.provider, configFile: file,
      fetch: () => { transports++; throw new Error('forbidden HTTP'); },
      createLocal: () => { transports++; throw new Error('forbidden backend'); } });
    assert.deepEqual((await gateway.dispatch({ method: 'tools/list' })).tools, catalog.providers[provider.provider]);
    assert.equal(gateway.file, file);
    for (const [other, tools] of Object.entries(catalog.providers)) if (other !== provider.provider) for (const tool of tools) {
      const result = await gateway.dispatch({ method: 'tools/call', params: { name: tool.name, arguments: {} } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Invalid Research Tools tool name/);
    }
    await gateway.close();
  }
  assert.equal(transports, 0);
  const invalid = path.join(directory, 'must-not-exist.json');
  assert.throws(() => new Gateway({ provider: 'unknown', configFile: invalid }), /Invalid Research Tools provider name/);
  assert.equal(fs.existsSync(invalid), false);
  assert.deepEqual(parseArgs(['--provider', 'fetch']), { provider: 'fetch' });
  assert.deepEqual(parseArgs([]), {});
  for (const args of [['--provider'], ['--provider', 'fetch', '--provider', 'exa'], ['--unexpected']]) assert.throws(() => parseArgs(args), /accepts only/);
});

test('generated packages match engine, contain only provider catalogs and use independent minimal config templates', () => {
  assert.equal(generate({ check: true }).length, 6);
  for (const plan of plans()) {
    const directory = path.join(__dirname, '../..', plan.name);
    const cli = ['context7', 'exa', 'tavily'].includes(plan.provider);
    assert.equal(JSON.parse(plan.files.get('package.json')).version, '0.1.2');
    assert.equal(JSON.parse(plan.files.get('package.json')).researchToolsProvider, plan.provider);
    assert.deepEqual(JSON.parse(plan.files.get('config.example.json')), template(plan.provider));
    assert.deepEqual(JSON.parse(plan.files.get('scripts/catalog.json')), { providers: { [plan.provider]: catalog.providers[plan.provider] } });
    assert.equal(plan.files.has('.mcp.json'), !cli);
    assert.equal(plan.files.has('scripts/server.cjs'), !cli);
    assert.equal(plan.files.has('scripts/command.cjs'), cli);
    const manifest = JSON.parse(plan.files.get('.codex-plugin/plugin.json'));
    assert.equal(Object.hasOwn(manifest, 'mcpServers'), !cli);
    if (!cli) {
      assert.equal(Object.values(JSON.parse(plan.files.get('.mcp.json')).mcpServers).length, 1);
      assert.deepEqual(JSON.parse(plan.files.get('.mcp.json')).mcpServers[plan.provider].args, ['scripts/server.cjs', '--provider', plan.provider]);
    }
    for (const [file, bytes] of plan.files) assert.deepEqual(fs.readFileSync(path.join(directory, file)), bytes);
    assert.equal(plan.files.has('scripts/sequential-core.cjs'), plan.provider === 'sequentialthinking');
    assert.equal(plan.files.has('scripts/local-backends.cjs'), plan.provider === 'fetch');
    assert.equal([...plan.files.keys()].some(file => file.startsWith('hooks/')), false);
    const skill = plan.files.get(`skills/${plan.name}/SKILL.md`).toString();
    assert.match(skill, new RegExp(`^---\\nname: ${plan.name}\\n`));
    for (const [other, tools] of Object.entries(catalog.providers)) if (other !== plan.provider) for (const tool of tools) {
      assert.equal(new RegExp('\\b' + tool.name + '\\b').test(skill), false, `foreign tool in ${plan.name} skill: ${tool.name}`);
    }
  }
});

test('independent profiles have fixed paths, isolated overrides and minimal exclusive config creation', t => {
  const directory = temporary(t);
  const overrides = Object.fromEntries(providers.map(p => [PROFILES[p.provider].override, path.join(directory, 'overrides', p.name + '.json')]));
  for (const provider of providers) {
    const selected = PROFILES[provider.provider];
    const expected = path.join(directory, selected.name, 'config.json');
    assert.equal(configPath({ CODEX_HOME: directory, RESEARCH_TOOLS_CONFIG: 'ignored-relative.json' }, undefined, provider.provider), expected);
    assert.equal(configPath({}, directory, provider.provider), path.join(directory, '.codex', selected.name, 'config.json'));
    assert.equal(configPath({ ...overrides, CODEX_HOME: directory }, undefined, provider.provider), overrides[selected.override]);
    assert.throws(() => configPath({ CODEX_HOME: directory, [selected.override]: 'relative.json' }, undefined, provider.provider), /absolute/);
    assert.equal(createConfig(expected, provider.provider), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(expected, 'utf8')), selected.key ? { version: 1, apiKey: '' } : { version: 1 });
    const content = Buffer.from(JSON.stringify(selected.key ? { version: 1, apiKey: `synthetic-${provider.provider}` } : { version: 1 }));
    fs.writeFileSync(expected, content);
    assert.equal(createConfig(expected, provider.provider), false);
    assert.deepEqual(fs.readFileSync(expected), content);
    assert.deepEqual(Object.keys(readConfig(expected, provider.provider)), ['version', provider.provider]);
  }
  assert.throws(() => configPath({}, directory, '../outside'), /Invalid Research Tools configuration provider/);
  assert.throws(() => createConfig(path.join(directory, 'outside/config.json'), 'unknown'), /Invalid Research Tools configuration provider/);
  assert.equal(fs.existsSync(path.join(directory, 'outside')), false);
});

test('each single-key provider rereads only its own JSON, redacts its key and resets only its own session', async t => {
  const directory = temporary(t);
  const states = [];
  for (const provider of ['context7', 'exa', 'tavily']) {
    const file = configPath({ CODEX_HOME: directory }, undefined, provider);
    createConfig(file, provider);
    const original = `synthetic-private-${provider}`;
    fs.writeFileSync(file, JSON.stringify({ version: 1, apiKey: original }));
    const calls = [];
    const gateway = new Gateway({ provider, env: { CODEX_HOME: directory, RESEARCH_TOOLS_CONFIG: path.join(directory, 'missing-combined.json') }, fetch: async (url, init) => {
      const rpc = JSON.parse(init.body);
      calls.push({ url, init, rpc });
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const key = init.headers.Authorization?.replace(/^Bearer /, '') || init.headers['x-api-key'] || new URL(url).searchParams.get('tavilyApiKey');
      const result = rpc.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: key }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), { headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'synthetic-session' } });
    } });
    t.after(() => gateway.close());
    const name = catalog.providers[provider][0].name;
    const result = await gateway.call({ name, arguments: { query: 'test' } });
    assert.equal(result.content[0].text, '[REDACTED]');
    states.push({ provider, gateway, calls, file, name });
  }
  fs.writeFileSync(states[1].file, JSON.stringify({ version: 1, apiKey: 'synthetic-rotated-exa' }));
  for (const state of states) {
    const result = await state.gateway.call({ name: state.name, arguments: { query: 'test' } });
    assert.equal(result.content[0].text, '[REDACTED]');
    assert.equal(state.calls.filter(call => call.rpc.method === 'initialize').length, state.provider === 'exa' ? 2 : 1);
    const last = state.calls.at(-1);
    if (state.provider === 'exa') assert.equal(last.init.headers['x-api-key'], 'synthetic-rotated-exa');
    assert.deepEqual([...state.gateway.states.keys()], [state.provider]);
  }
  assert.equal(fs.existsSync(path.join(directory, 'missing-combined.json')), false);
});

test('generator preflights all targets, refuses manual edits or unknown files and check does not create directories', t => {
  const directory = temporary(t);
  const missing = path.join(directory, 'missing');
  assert.throws(() => generate({ outputRoot: missing, check: true }), /does not exist/);
  assert.equal(fs.existsSync(missing), false);
  generate({ outputRoot: directory });
  assert.equal(generate({ outputRoot: directory, check: true }).length, 6);
  const edited = path.join(directory, 'fetch-codex/scripts/server.cjs');
  const original = fs.readFileSync(edited);
  fs.appendFileSync(edited, '\n// user work\n');
  const manual = fs.readFileSync(edited);
  assert.throws(() => generate({ outputRoot: directory }), /manual changes/);
  assert.deepEqual(fs.readFileSync(edited), manual);
  assert.throws(() => generate({ outputRoot: directory, check: true }), /differs/);
  fs.writeFileSync(edited, original);
  const unrelated = path.join(directory, 'tavily-codex/user-note.txt');
  fs.writeFileSync(unrelated, 'keep this file');
  assert.throws(() => generate({ outputRoot: directory }), /unknown file/);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep this file');
});

test('six isolated package entry points discover only their own tools with zero HTTP or child runtime startup', async t => {
  const directory = temporary(t);
  const ignored = path.join(directory, 'ignored-shared.json');
  fs.writeFileSync(ignored, 'must never read combined config');
  const sessions = [];
  for (const provider of providers) {
    const file = path.join(directory, provider.name, 'private-config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const config = Buffer.from(JSON.stringify(PROFILES[provider.provider].key ? { version: 1, apiKey: `synthetic-${provider.provider}-key` } : { version: 1 }));
    fs.writeFileSync(file, config);
    const standalone = path.join(directory, provider.name);
    fs.cpSync(path.join(__dirname, '../..', provider.name), standalone, { recursive: true });
    const guard = path.join(directory, `${provider.name}-guard.cjs`);
    fs.writeFileSync(guard, `
      global.fetch = () => { throw new Error('cold HTTP forbidden'); };
      require('node:child_process').spawn = () => { throw new Error('cold child forbidden'); };
      const Module = require('node:module'); const load = Module._load;
      const builtins = new Set(Module.builtinModules);
      Module._load = function (id, parent, ...args) {
        if (!id.startsWith('node:') && !builtins.has(id)) {
          const target = Module._resolveFilename(id, parent);
          if (!target.startsWith(${JSON.stringify(standalone + path.sep)})) throw new Error('outside package import');
        }
        if (/local-backends|sequential-core/.test(id)) throw new Error('cold backend forbidden');
        return load.call(this, id, parent, ...args);
      };
    `);
    const env = { ...process.env, CODEX_HOME: directory, RESEARCH_TOOLS_CONFIG: ignored, [PROFILES[provider.provider].override]: file };
    for (const args of [[], ['--doctor']]) {
      const setup = spawnSync(process.execPath, ['scripts/setup.cjs', ...args], { cwd: standalone, env, encoding: 'utf8', windowsHide: true });
      assert.equal(setup.status, 0);
      assert.doesNotMatch(setup.stdout + setup.stderr, /synthetic-/);
      assert.deepEqual(fs.readFileSync(file), config);
    }
    if (['context7', 'exa', 'tavily'].includes(provider.provider)) {
      const list = spawnSync(process.execPath, ['--require', guard, 'scripts/command.cjs', '--list'], { cwd: standalone, env, encoding: 'utf8', windowsHide: true });
      assert.equal(list.status, 0);
      assert.equal(list.stderr, '');
      assert.deepEqual(JSON.parse(list.stdout), { provider: provider.provider, commands: catalog.providers[provider.provider] });
      const foreign = providers.find(p => p.provider !== provider.provider);
      const reject = spawnSync(process.execPath, ['--require', guard, 'scripts/command.cjs'], { cwd: standalone, env, encoding: 'utf8', windowsHide: true, input: JSON.stringify({ name: catalog.providers[foreign.provider][0].name, arguments: {} }) });
      assert.equal(reject.status, 1);
      assert.equal(reject.stderr, '');
      assert.equal(JSON.parse(reject.stdout).isError, true);
      assert.deepEqual(fs.readFileSync(file), config);
      assert.equal(fs.existsSync(path.join(directory, provider.name, 'runtime')), false);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(standalone, '.mcp.json'))).mcpServers[provider.provider];
    const child = spawn(process.execPath, ['--require', guard, ...manifest.args], { cwd: standalone, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let output = '', stderr = '';
    child.stderr.on('data', value => { stderr += value; });
    const replies = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('package discovery timeout')), 5000);
      child.once('error', reject);
      child.stdout.on('data', value => { output += value; if (output.trim().split('\n').length >= 3) { clearTimeout(timer); resolve(output.trim().split('\n').map(line => JSON.parse(line))); } });
    });
    const foreign = providers.find(p => p.provider !== provider.provider);
    for (const message of [{ id: 1, method: 'initialize' }, { id: 2, method: 'tools/list' }, { id: 3, method: 'tools/call', params: { name: catalog.providers[foreign.provider][0].name } }]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    sessions.push({ child, replies, provider, file, config, stderr: () => stderr });
  }
  assert.equal(new Set(sessions.map(session => session.child.pid)).size, 3);
  for (const session of sessions) {
    const responses = await session.replies;
    assert.deepEqual(responses.find(r => r.id === 1).result.serverInfo, { name: session.provider.name, version: '0.1.2' });
    assert.deepEqual(responses.find(r => r.id === 2).result.tools, catalog.providers[session.provider.provider]);
    assert.equal(responses.find(r => r.id === 3).result.isError, true);
    const done = new Promise(resolve => session.child.once('exit', (code, signal) => resolve({ code, signal })));
    session.child.stdin.end();
    assert.deepEqual(await done, { code: 0, signal: null });
    assert.equal(session.stderr(), '');
    assert.deepEqual(fs.readFileSync(session.file), session.config);
  }
  assert.equal(fs.readFileSync(ignored, 'utf8'), 'must never read combined config');
});
