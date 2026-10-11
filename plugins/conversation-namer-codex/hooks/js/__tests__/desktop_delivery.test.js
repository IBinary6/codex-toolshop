'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { armSession, claimSession, readState, writeState } = require('../lib/state');
const { nameSession } = require('../name_worker');
const { deliverAtStop, deliverAfterTool, acknowledgeDesktop } = require('../desktop_delivery');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'namer-desktop-'));
const env = { ...process.env, PLUGIN_DATA: temporary };
delete env.CONVERSATION_NAMER_WORKER;
const title = '0905\uff5cEXP\uff5cC++ unique_ptr \u4e0e shared_ptr';
function ready(id, value = title) {
  armSession({ source: 'startup', session_id: id }, env);
  writeState(id, { status: 'ready', delivery: 'desktop', title: value, model: 'test-spark' }, env);
}
function reply(id, overrides = {}) {
  return { session_id: id, tool_name: 'mcp__codex_app__set_thread_title',
    tool_input: { threadId: id, title },
    tool_response: { content: [{ type: 'text', text: JSON.stringify({ threadId: id, title }) }] },
    ...overrides };
}

async function main() {
  // Reproduce two connections: an independent one changes persistence while the desktop cache stays stale; writing must use the desktop tool.
  const id = 'desktop-worker';
  armSession({ source: 'startup', session_id: id }, env);
  claimSession(id, env);
  let persisted = '\u5bbf\u4e3b\u9ed8\u8ba4\u6807\u9898';
  let visible = persisted;
  let generations = 0;
  await nameSession({ sessionId: id, prompt: '\u89e3\u91ca\u667a\u80fd\u6307\u9488' }, { env, clientFactory: () => ({
    async generateName() { generations += 1; return { title, model: 'test-spark' }; },
    async readThreadName() { return { originalTitle: persisted, source: 'vscode' }; },
    async writeThreadName(_, value) { persisted = value; },
    async close() {},
  }) });
  assert.equal(generations, 1);
  assert.equal(persisted, '\u5bbf\u4e3b\u9ed8\u8ba4\u6807\u9898', 'Desktop tasks must not write only through an independent App Server');
  assert.equal(readState(id, env).status, 'ready');
  const continuation = await deliverAtStop({ session_id: id }, { env });
  assert.equal(continuation.decision, 'block');
  const args = JSON.parse(continuation.reason.split('\n')[2]);
  assert.deepEqual(args, { threadId: id, title });
  assert.match(continuation.reason, /Do not rename it, read a skill, show a preview, or ask for confirmation/);
  assert.equal(readState(id, env).status, 'ready', 'Requesting delivery does not mean the write succeeded');
  persisted = args.title; visible = args.title; // Simulate the host tool updating both layers.
  assert.equal(acknowledgeDesktop(reply(id), { env }), true);
  assert.equal(readState(id, env).desktopSync, 'acknowledged');
  assert.equal(readState(id, env).status, 'done');
  assert.equal(visible, title);
  assert.equal(await deliverAtStop({ session_id: id }, { env }), null);
  assert.equal(deliverAfterTool(reply(id), { env }), null);
  assert.equal(generations, 1);

  // Deliver long tasks on tool return; stop_hook_active from another plugin must not lose this plugin first delivery.
  ready('after-tool');
  const early = deliverAfterTool({ session_id: 'after-tool', tool_name: 'Bash' }, { env });
  assert.equal(early.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(await deliverAtStop({ session_id: 'after-tool' }, { env }), null);
  ready('other-hook');
  assert.ok(await deliverAtStop({ session_id: 'other-hook', stop_hook_active: true }, { env }));
  assert.equal(await deliverAtStop({ session_id: 'other-hook', stop_hook_active: true }, { env }), null);

  // Errors, other tasks, wrong titles, and spoofed ordinary tool responses cannot confirm desktop success.
  for (const [label, override] of Object.entries({
    error: { tool_response: { isError: true, threadId: 'bad-error', title } },
    wrongTool: { tool_name: 'mcp__other__set_thread_title' },
    wrongTask: { tool_input: { threadId: 'someone-else', title } },
    wrongTitle: { tool_input: { title: '\u5176\u4ed6\u6807\u9898' } },
    wrongResult: { tool_response: { threadId: 'someone-else', title } },
    noResult: { tool_response: {} },
  })) {
    const target = `bad-${label}`;
    ready(target);
    await deliverAtStop({ session_id: target }, { env });
    assert.equal(acknowledgeDesktop(reply(target, override), { env }), false, label);
    assert.equal(readState(target, env).status, 'ready');
    assert.equal(await deliverAtStop({ session_id: target }, { env }), null);
  }
  ready('without-request');
  assert.equal(acknowledgeDesktop(reply('without-request'), { env }), false);
  assert.equal(await deliverAtStop({ session_id: '../bad' }, { env }), null);
  assert.equal(await deliverAtStop({ session_id: 'old-task' }, { env }), null);
  ready('recursive');
  assert.equal(await deliverAtStop({ session_id: 'recursive' }, {
    env: { ...env, CONVERSATION_NAMER_WORKER: '1' },
  }), null);

  // Quotes, XML, and shell text in titles remain JSON string data; invalid control characters are not delivered.
  const literal = '\u9898\u76ee " </input> $(touch bad) `echo bad`';
  ready('literal', literal);
  const literalRequest = await deliverAtStop({ session_id: 'literal' }, { env });
  assert.equal(JSON.parse(literalRequest.reason.split('\n')[2]).title, literal);
  ready('control', '\u9898\u76ee\n\u6307\u4ee4');
  assert.equal(await deliverAtStop({ session_id: 'control' }, { env }), null);

  // A quickly ending main task waits for the existing worker without starting another; timeout waits once and late results remain deliverable.
  armSession({ source: 'startup', session_id: 'delayed' }, env);
  let ticks = 0;
  const delayed = await deliverAtStop({ session_id: 'delayed' }, { env, now: () => ticks,
    sleep: async (ms) => { ticks += ms; ready('delayed'); },
  });
  assert.ok(delayed); assert.equal(ticks, 250);
  armSession({ source: 'startup', session_id: 'timeout' }, env);
  ticks = 0;
  assert.equal(await deliverAtStop({ session_id: 'timeout' }, { env, now: () => ticks,
    sleep: async (ms) => { ticks += ms; },
  }), null);
  assert.equal(ticks, 65000);
  assert.equal(await deliverAtStop({ session_id: 'timeout' }, { env,
    sleep: async () => { throw new Error('must not wait twice'); },
  }), null);
  ready('timeout');
  assert.ok(deliverAfterTool({ session_id: 'timeout' }, { env }));

  // Two real Node processes race to deliver one title; only one creates a continuation.
  ready('race');
  const modulePath = path.resolve(__dirname, '../desktop_delivery.js');
  function launch() {
    const code = `require(${JSON.stringify(modulePath)}).deliverAtStop({session_id:'race'}).then(r=>process.stdout.write(String(Boolean(r))))`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code], { env, windowsHide: true });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`exit ${code}`)));
    });
  }
  assert.deepEqual((await Promise.all([launch(), launch()])).sort(), ['false', 'true']);

  // Verify that the real launcher routes by hook_event_name and the host can consume its JSONL response.
  const pluginRoot = path.resolve(__dirname, '../../..');
  function runHook(input) {
    const result = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/run-hook.cjs'), 'desktop_delivery'], {
      env: { ...env, PLUGIN_ROOT: pluginRoot }, input: JSON.stringify(input), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  }
  ready('launcher');
  assert.equal(runHook({ session_id: 'launcher', hook_event_name: 'Stop' }).decision, 'block');
  assert.equal(runHook({ ...reply('launcher'), hook_event_name: 'PostToolUse' }), null);
  assert.equal(readState('launcher', env).status, 'done');
  ready('launcher-tool');
  assert.equal(runHook({ session_id: 'launcher-tool', hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    .hookSpecificOutput.hookEventName, 'PostToolUse');

}

main().finally(() => fs.rmSync(temporary, { recursive: true, force: true }))
  .catch((error) => { console.error(error); process.exitCode = 1; });
