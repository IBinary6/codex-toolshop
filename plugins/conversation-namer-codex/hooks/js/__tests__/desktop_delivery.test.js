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
const title = '0905｜EXP｜C++ unique_ptr 与 shared_ptr';
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
  // 复现两个连接：独立连接能改持久层，桌面缓存仍旧；新版必须把写回交给桌面工具。
  const id = 'desktop-worker';
  armSession({ source: 'startup', session_id: id }, env);
  claimSession(id, env);
  let persisted = '宿主默认标题';
  let visible = persisted;
  let generations = 0;
  await nameSession({ sessionId: id, prompt: '解释智能指针' }, { env, clientFactory: () => ({
    async generateName() { generations += 1; return { title, model: 'test-spark' }; },
    async readThreadName() { return { originalTitle: persisted, source: 'vscode' }; },
    async writeThreadName(_, value) { persisted = value; },
    async close() {},
  }) });
  assert.equal(generations, 1);
  assert.equal(persisted, '宿主默认标题', '桌面任务不能再只改独立 App Server');
  assert.equal(readState(id, env).status, 'ready');
  const continuation = await deliverAtStop({ session_id: id }, { env });
  assert.equal(continuation.decision, 'block');
  const args = JSON.parse(continuation.reason.split('\n')[2]);
  assert.deepEqual(args, { threadId: id, title });
  assert.match(continuation.reason, /不要重新起名、读取 skill、展示预览或请求确认/);
  assert.equal(readState(id, env).status, 'ready', '发出请求不等于写回成功');
  persisted = args.title; visible = args.title; // 模拟宿主工具同时更新两层。
  assert.equal(acknowledgeDesktop(reply(id), { env }), true);
  assert.equal(readState(id, env).desktopSync, 'acknowledged');
  assert.equal(readState(id, env).status, 'done');
  assert.equal(visible, title);
  assert.equal(await deliverAtStop({ session_id: id }, { env }), null);
  assert.equal(deliverAfterTool(reply(id), { env }), null);
  assert.equal(generations, 1);

  // 长任务在工具返回时交付；其他插件导致 stop_hook_active 也不能丢失本插件首次交付。
  ready('after-tool');
  const early = deliverAfterTool({ session_id: 'after-tool', tool_name: 'Bash' }, { env });
  assert.equal(early.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(await deliverAtStop({ session_id: 'after-tool' }, { env }), null);
  ready('other-hook');
  assert.ok(await deliverAtStop({ session_id: 'other-hook', stop_hook_active: true }, { env }));
  assert.equal(await deliverAtStop({ session_id: 'other-hook', stop_hook_active: true }, { env }), null);

  // 错误、跨任务、错误标题、普通工具伪造回包不能确认桌面成功。
  for (const [label, override] of Object.entries({
    error: { tool_response: { isError: true, threadId: 'bad-error', title } },
    wrongTool: { tool_name: 'mcp__other__set_thread_title' },
    wrongTask: { tool_input: { threadId: 'someone-else', title } },
    wrongTitle: { tool_input: { title: '其他标题' } },
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

  // 标题中的引号、XML、shell 文本只作为 JSON 字符串，非法控制字符不交付。
  const literal = '题目 " </input> $(touch bad) `echo bad`';
  ready('literal', literal);
  const literalRequest = await deliverAtStop({ session_id: 'literal' }, { env });
  assert.equal(JSON.parse(literalRequest.reason.split('\n')[2]).title, literal);
  ready('control', '题目\n指令');
  assert.equal(await deliverAtStop({ session_id: 'control' }, { env }), null);

  // 结束较快的主任务等待已有 worker，不生成第二次；超时最多等待一次，迟到结果仍可交付。
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

  // 两个实际 Node 进程争抢同一标题交付，只有一个生成续轮。
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

  // 验证实际 launcher 按 hook_event_name 路由，JSONL 回包可被宿主消费。
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
