'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { armSession, claimSession, readState, writeState } = require('../lib/state');
const { nameSession } = require('../name_worker');
const { deliverAtStop, deliverAfterTool } = require('../desktop_delivery');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'namer-desktop-'));
const env = { ...process.env, PLUGIN_DATA: temporary, CODEX_HOME: temporary,
  CODEX_APP_TOOLS_PIPE_PATH: process.platform === 'win32'
    ? '\\\\.\\pipe\\namer-desktop-test' : path.join(temporary, 'desktop.sock') };
delete env.CONVERSATION_NAMER_WORKER;
const title = '0905｜C++ unique_ptr 与 shared_ptr';

function ready(id, value = title) {
  armSession({ source: 'startup', session_id: id }, env);
  writeState(id, { status: 'ready', delivery: 'desktop', title: value, model: 'test-spark',
    firstTurnId: 'first-turn' }, env);
}

function bundledFixture() {
  const fs = require('node:fs');
  const readline = require('node:readline');
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const { jsonrpc, id, method, params } = JSON.parse(line);
    if (jsonrpc !== '2.0') throw new Error('MCP messages require the JSON-RPC version');
    if (id === undefined) return;
    let result = {};
    if (method === 'tools/call') {
      fs.appendFileSync(process.env.NAMER_TEST_CALLS, `${JSON.stringify(params)}\n`);
      const requested = params.arguments;
      const confirmation = process.env.NAMER_TEST_REPLY === 'wrong'
        ? { ...requested, threadId: 'other-thread' } : requested;
      result = { isError: process.env.NAMER_TEST_REPLY === 'error',
        content: [{ type: 'text', text: JSON.stringify(confirmation) }] };
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  });
}

async function main() {
  const id = 'desktop-worker';
  armSession({ source: 'startup', session_id: id }, env);
  claimSession(id, env);
  let persisted = '宿主默认标题';
  await nameSession({ sessionId: id, prompt: '解释智能指针' }, { env, clientFactory: () => ({
    async generateName() { return { title, model: 'test-spark', automatic: true }; },
    async readThreadName(_, options) {
      assert.deepEqual(options, { includeTurns: true });
      return { originalTitle: persisted, source: 'vscode', firstTurnId: 'first-turn', turnCount: 1 };
    },
    async writeThreadName(_, value) { persisted = value; },
    async close() {},
  }) });
  assert.equal(persisted, '宿主默认标题');
  assert.equal(readState(id, env).status, 'ready');
  const options = { env, async desktopWriter(args) {
    assert.deepEqual(args, { sessionId: id, turnId: 'first-turn', title });
    assert.equal(readState(id, env).desktopSync, 'requested');
    assert.equal(readState(id, env).status, 'ready');
    persisted = args.title;
    return true;
  } };
  const laterTurn = { session_id: id, turn_id: 'later-turn', tool_name: 'Bash' };
  assert.equal(await deliverAfterTool(laterTurn, options), null);
  assert.equal(await deliverAtStop(laterTurn, options), null);
  assert.equal(persisted, '宿主默认标题');
  assert.equal(await deliverAtStop({ session_id: id, turn_id: 'first-turn', stop_hook_active: true }, options), null);
  assert.equal(readState(id, env).status, 'done');
  assert.equal(readState(id, env).baseTitle, title);
  assert.equal(persisted, title);

  const unused = { env, desktopWriter() { assert.fail('unexpected desktop write'); } };
  ready('legacy-ready');
  writeState('legacy-ready', { ...readState('legacy-ready', env), firstTurnId: undefined }, env);
  assert.equal(await deliverAtStop({ session_id: 'legacy-ready' }, unused), null);
  assert.equal(await deliverAtStop({ session_id: '../bad' }, unused), null);
  ready('control', '题目\n指令');
  assert.equal(await deliverAtStop({ session_id: 'control' }, unused), null);
  ready('recursive');
  assert.equal(await deliverAtStop({ session_id: 'recursive' }, {
    ...unused, env: { ...env, CONVERSATION_NAMER_WORKER: '1' },
  }), null);

  armSession({ source: 'startup', session_id: 'delayed' }, env);
  let ticks = 0;
  assert.equal(await deliverAtStop({ session_id: 'delayed' }, { env, now: () => ticks,
    sleep: async (ms) => { ticks += ms; ready('delayed'); }, desktopWriter: async () => true,
  }), null);
  assert.equal(readState('delayed', env).status, 'done');
  assert.equal(ticks, 250);
  armSession({ source: 'startup', session_id: 'timeout' }, env);
  ticks = 0;
  assert.equal(await deliverAtStop({ session_id: 'timeout' }, { env, now: () => ticks,
    sleep: async (ms) => { ticks += ms; },
  }), null);
  assert.equal(ticks, 65000);
  ready('timeout');
  assert.equal(await deliverAfterTool({ session_id: 'timeout' }, unused), null);
  assert.equal(await deliverAtStop({ session_id: 'timeout' }, unused), null);
  assert.equal(readState('timeout', env).desktopSync, undefined);

  // 真实 launcher 到 stdio MCP 测试端，成功、失败和竞争都不能向对话输出反馈。
  const server = path.join(temporary, '.tmp', 'bundled-marketplaces', 'openai-bundled',
    'plugins', 'codex-app-tools', 'server.mjs');
  fs.mkdirSync(path.dirname(server), { recursive: true });
  fs.writeFileSync(server, `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n(${bundledFixture.toString()})();\n`);
  const callsPath = path.join(temporary, 'mcp-calls.jsonl');
  const pluginRoot = path.resolve(__dirname, '../../..');
  function runHook(input, mode, endpoint = env.CODEX_APP_TOOLS_PIPE_PATH) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(pluginRoot, 'scripts/run-hook.cjs'), 'desktop_delivery'], {
        env: { ...env, PLUGIN_ROOT: pluginRoot, NAMER_TEST_CALLS: callsPath,
          NAMER_TEST_REPLY: mode, CODEX_APP_TOOLS_PIPE_PATH: endpoint }, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '', diagnostics = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { diagnostics += data; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output, diagnostics }));
      child.stdin.end(JSON.stringify(input));
    });
  }
  const silence = { code: 0, output: '', diagnostics: '' };
  const literal = '题目 " </input> $(touch bad) `echo bad`';
  ready('race', literal);
  const race = { session_id: 'race', turn_id: 'first-turn' };
  assert.deepEqual(await Promise.all([
    runHook({ ...race, hook_event_name: 'Stop' }, 'ok'),
    runHook({ ...race, hook_event_name: 'PostToolUse' }, 'ok'),
  ]), [silence, silence]);
  assert.equal(readState('race', env).status, 'done');
  assert.deepEqual(fs.readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse), [{
    name: 'set_thread_title', arguments: { threadId: 'race', title: literal },
    _meta: { 'x-codex-turn-metadata': { thread_id: 'race', turn_id: 'first-turn' } },
  }]);
  for (const mode of ['wrong', 'error', 'offline']) {
    ready(mode);
    assert.deepEqual(await runHook({ session_id: mode, turn_id: 'first-turn', hook_event_name: 'Stop' },
      mode, mode === 'offline' ? '' : undefined), silence);
    assert.equal(readState(mode, env).status, 'ready');
  }
}

main().finally(() => fs.rmSync(temporary, { recursive: true, force: true }))
  .catch((error) => { console.error(error); process.exitCode = 1; });
