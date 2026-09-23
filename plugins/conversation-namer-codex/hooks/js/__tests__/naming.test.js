'use strict';

const assert = require('assert').strict;
const { spawn } = require('child_process');
const { once } = require('events');
const fs = require('fs');
const path = require('path');
const { createNamingClient, generateName, lowestEffort, parseName, selectModel } = require('../lib/naming');

const pluginRoot = path.resolve(__dirname, '..', '..', '..');
const createdAt = Date.parse('2026-09-05T18:30:00Z') / 1000;
const model = {
  id: 'future-mini', model: 'gpt-future-mini', hidden: false,
  description: 'A compact model for routine work.',
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'none' }],
};

function fakeServer({ output, items, thread = {}, models = [model], fail, finalOnly = false } = {}) {
  const calls = [];
  const notifications = new Set();
  const failures = new Set();
  let title = 'original';
  let closed = false;
  let configuration;
  const rpc = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === fail) throw new Error('fake_rpc_failed');
      if (method === 'initialize') return {};
      if (method === 'thread/read') return { thread: { id: params.threadId, createdAt, name: title, ...thread } };
      if (method === 'thread/name/set') { title = params.name; return {}; }
      if (method === 'model/list') return { data: models, nextCursor: null };
      if (method === 'config/read') return { config: {
        mcp_servers: {
          'server.with.dot': { command: 'do-not-copy', env: { SECRET: 'not-for-model' } },
          'computer-use': { command: 'do-not-copy' },
          'server"quoted': { command: 'do-not-copy' },
        },
        developer_instructions: 'do-not-inherit',
      } };
      if (method === 'thread/start') return { thread: { id: 'temporary' }, model: params.model };
      if (method === 'turn/start') {
        const finalItems = items || [{
          id: 'answer', type: 'agentMessage', text: output ?? '{"action":"name","type":"EXP","topic":"插件审查"}',
        }];
        queueMicrotask(() => {
          if (!finalOnly) {
            for (const item of finalItems) {
              for (const listener of notifications) listener('item/completed', {
                threadId: 'temporary', turnId: 'turn-1', item,
              });
            }
          }
          for (const listener of notifications) listener('turn/completed', {
            threadId: 'temporary', turn: { id: 'turn-1', status: 'completed', items: finalOnly ? finalItems : [] },
          });
        });
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      throw new Error(`unexpected_method:${method}`);
    },
    notify(method) { calls.push({ method }); },
    onNotification(listener) { notifications.add(listener); return () => notifications.delete(listener); },
    onFailure(listener) { failures.add(listener); return () => failures.delete(listener); },
    abort(code) { for (const listener of failures) listener(new Error(code)); },
    async close() { closed = true; },
  };
  return {
    calls,
    appServerFactory(options) { configuration = options; return rpc; },
    get configuration() { return configuration; },
    get closed() { return closed; },
  };
}

async function main() {
  const luna = {
    ...model,
    id: 'gpt-5.6-luna',
    model: 'gpt-5.6-luna',
    description: 'Fast and affordable model for everyday work.',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
  };
  const futureLuna = { ...model, id: 'gpt-6-luna', model: 'gpt-6-luna', description: undefined };
  const dottedLuna = { ...model, id: 'gpt6.luna', model: 'gpt6.luna', description: undefined };
  const unknownAffordable = {
    ...model,
    id: 'orion-small',
    model: 'orion-small',
    description: 'An affordable model for everyday tasks.',
    supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }],
  };
  const cheapestLow = {
    ...model,
    id: 'budget-low',
    model: 'budget-low',
    description: 'Our cheapest general-purpose model.',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
  };
  const cheapestNone = {
    ...model,
    id: 'budget-none',
    model: 'budget-none',
    description: 'The lowest cost option for short tasks.',
  };
  const large = { ...model, id: 'large', model: 'gpt-large' };
  assert.equal(selectModel([futureLuna, unknownAffordable]), unknownAffordable,
    '目录描述的低成本信号应优先于轻量家族兜底');
  assert.equal(selectModel([luna, unknownAffordable]), unknownAffordable,
    '同档描述信号应选择支持的最低推理档位');
  assert.equal(selectModel([cheapestLow, cheapestNone]), cheapestNone,
    '同档低成本信号应选择支持的最低推理档位');
  assert.equal(selectModel([cheapestNone, { ...cheapestNone, id: 'second', model: 'second' }]), cheapestNone,
    '同档同推理档位保留目录稳定顺序');
  assert.equal(selectModel([luna]), luna);
  assert.equal(selectModel([futureLuna]), futureLuna);
  assert.equal(selectModel([dottedLuna]), dottedLuna);
  assert.equal(selectModel([unknownAffordable]), unknownAffordable);
  for (const description of ['A low-cost model.', 'A cost-effective model.', 'An economical model.']) {
    const described = { ...unknownAffordable, description };
    assert.equal(selectModel([described]), described);
  }
  const highOnlyMini = { ...model, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
  assert.equal(selectModel([highOnlyMini, luna]), luna);
  assert.equal(selectModel([highOnlyMini]), null);
  assert.equal(selectModel([large]), null);
  assert.equal(selectModel([{ ...model, hidden: true }]), null);
  assert.equal(selectModel([{ ...model, inputModalities: ['audio'] }]), null);
  assert.equal(selectModel([{ ...unknownAffordable, hidden: true }, large]), null);
  assert.equal(selectModel([{ ...unknownAffordable, inputModalities: ['audio'] }, large]), null);
  assert.equal(selectModel([{ ...unknownAffordable,
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }, large]), null);
  assert.equal(selectModel([model], 'missing-model'), null);
  assert.equal(selectModel([model], model.id), model);
  assert.equal(selectModel([luna, futureLuna], 'gpt-6-luna'), futureLuna);
  assert.equal(selectModel([luna], 'gpt-6-luna'), null,
    '指定 GPT-6 Luna 不可用时不得自动换回旧型号');
  assert.equal(lowestEffort(model), 'none');
  assert.equal(lowestEffort({ supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }), 'low');
  assert.equal(lowestEffort({ supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'low' }] }), 'minimal');
  assert.equal(lowestEffort({ supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }), null);
  assert.equal(lowestEffort({}), null);
  assert.equal(lowestEffort(luna), 'low', '不得为 Luna 伪造未声明的 none 档位');

  const name = (topic, type = 'EXP') => JSON.stringify({ action: 'name', type, topic });
  assert.deepEqual(parseName(name('插件审查'), createdAt, ''), { title: '0906｜EXP｜插件审查' });
  assert.deepEqual(parseName(name('插件审查', '探索'), createdAt, ''), { title: '0906｜探索｜插件审查' });
  assert.deepEqual(parseName(name('跨年'), Date.parse('2026-12-31T17:00:00Z') / 1000, ''), { title: '0101｜EXP｜跨年' });
  for (const invalidDate of [null, undefined, '2026-09-05', -1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(parseName(name('日期缺失'), invalidDate, ''), { skipped: 'missing_created_at' });
  }
  assert.deepEqual(parseName('{"action":"skip","type":"","topic":""}', null, ''), { skipped: 'model_skipped' });
  assert.deepEqual(parseName('{"action":"exact","type":"","topic":"我的标题"}', null, '标题设为我的标题'), { title: '我的标题' });
  assert.throws(() => parseName('{"action":"exact","type":"","topic":"凭空产生"}', null, '其他主题'), /invalid_exact_title/);
  for (const invalid of [
    'not-json', '```json\n{}\n```', '[]', 'null', '{}',
    '{"action":"name","type":"EXP","topic":"正常","extra":true}',
    name('有\n换行'), name('控制\u0000字符'), name('双向\u202e字符'), name('零宽\u200b字符'),
    name('有｜分隔'), name('有|分隔'), name(' 空白'), name(''), name('a'.repeat(65)), name('主题', 'BAD'),
  ]) assert.throws(() => parseName(invalid, createdAt, ''), /invalid_name_output/);

  const fake = fakeServer();
  const client = createNamingClient({ sessionId: 'current', prompt: '审查插件', pluginRoot,
    timeoutMs: 1200, appServerFactory: fake.appServerFactory });
  const result = await client.generateName();
  assert.deepEqual(result, { title: '0906｜EXP｜插件审查', model: model.model, createdAt, originalTitle: 'original' });
  assert.equal(fake.calls.some((call) => call.method === 'thread/name/set'), false, '生成不得自行写标题');
  assert.equal(fake.configuration.timeoutMs, 1200);
  assert.ok(fs.existsSync(fake.configuration.cwd));
  assert.notEqual(fake.configuration.cwd, pluginRoot);
  const start = fake.calls.find((call) => call.method === 'thread/start').params;
  assert.equal(start.ephemeral, true);
  assert.equal(start.allowProviderModelFallback, false);
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.sandbox, 'read-only');
  assert.deepEqual(start.environments, []);
  assert.deepEqual(start.dynamicTools, []);
  assert.deepEqual(start.config.mcp_servers, {
    'server.with.dot': { enabled: false, required: false },
    'computer-use': { enabled: false, required: false },
    'server"quoted': { enabled: false, required: false },
  });
  assert.equal(Object.keys(start.config).some((key) => key.startsWith('mcp_servers.')), false);
  assert.equal(start.config.project_doc_max_bytes, 0);
  assert.equal(start.config.web_search, 'disabled');
  assert.equal(start.config.service_tier, 'default');
  for (const feature of ['hooks', 'plugins', 'apps', 'shell_tool', 'memories', 'multi_agent', 'browser_use',
    'computer_use', 'image_generation', 'view_image', 'code_mode_host', 'unified_exec']) {
    assert.equal(start.config[`features.${feature}`], false);
  }
  assert.doesNotMatch(JSON.stringify(start), /not-for-model|do-not-copy|do-not-inherit/);
  const turn = fake.calls.find((call) => call.method === 'turn/start').params;
  assert.deepEqual(turn.input, [{ type: 'text', text: '审查插件' }]);
  assert.equal(turn.effort, 'none');
  assert.equal(turn.summary, 'none');
  assert.deepEqual(turn.environments, []);
  assert.equal(turn.outputSchema.additionalProperties, false);
  assert.equal((await client.readThreadName('current')).originalTitle, 'original');
  await client.writeThreadName('current', result.title);
  assert.equal((await client.readThreadName('current')).originalTitle, result.title);
  await assert.rejects(client.writeThreadName('current', '标题\n换行'), /invalid_title_write/);
  await client.close();
  await client.close();
  assert.equal(fake.closed, true);
  assert.equal(fs.existsSync(fake.configuration.cwd), false);
  await assert.rejects(client.readThreadName('current'), /naming_client_closed/);

  if (process.platform === 'win32') {
    const occupied = fakeServer();
    let worker;
    let occupiedDirectory;
    const occupiedClient = createNamingClient({ appServerFactory(options) {
      occupiedDirectory = options.cwd;
      const rpc = occupied.appServerFactory(options);
      worker = spawn(process.execPath, ['-e',
        "process.stdout.write('ready\\n'); setTimeout(() => {}, 300);"], {
        cwd: occupiedDirectory,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const ready = once(worker.stdout, 'data');
      return {
        ...rpc,
        async request(method, params) {
          if (method === 'initialize') await ready;
          return rpc.request(method, params);
        },
      };
    } });
    await occupiedClient.readThreadName('current');
    try {
      await occupiedClient.close();
      assert.equal(fs.existsSync(occupiedDirectory), false,
        'close 返回前必须完成命名临时目录清理');
    } finally {
      if (worker.exitCode === null) await once(worker, 'exit');
      fs.rmSync(occupiedDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  const permanent = fakeServer();
  const permanentClient = createNamingClient({ appServerFactory: permanent.appServerFactory });
  await permanentClient.readThreadName('current');
  const originalRm = fs.promises.rm;
  let cleanupOptions;
  fs.promises.rm = async (directory, options) => {
    cleanupOptions = options;
    const error = new Error('permanent_cleanup_error');
    error.code = 'EACCES';
    throw error;
  };
  try {
    await assert.rejects(permanentClient.close(), /permanent_cleanup_error/);
  } finally {
    fs.promises.rm = originalRm;
    await originalRm(permanent.configuration.cwd, { recursive: true, force: true });
  }
  assert.equal(cleanupOptions.maxRetries, 5);
  assert.equal(cleanupOptions.retryDelay, 100);

  const lowEffort = fakeServer({ models: [luna] });
  const lowEffortResult = await generateName({ sessionId: 'current', prompt: '审查插件', pluginRoot,
    appServerFactory: lowEffort.appServerFactory });
  assert.equal(lowEffortResult.model, luna.model);
  assert.equal(lowEffort.calls.find((call) => call.method === 'turn/start').params.effort, 'low');

  const gpt6 = fakeServer({ models: [luna, futureLuna] });
  const gpt6Result = await generateName({ sessionId: 'current', prompt: '审查插件', pluginRoot,
    model: 'gpt-6-luna', appServerFactory: gpt6.appServerFactory });
  assert.equal(gpt6Result.model, 'gpt-6-luna');
  assert.equal(gpt6.calls.find((call) => call.method === 'turn/start').params.model, 'gpt-6-luna');
  assert.equal(gpt6.calls.some((call) => call.method === 'thread/name/set'), false);

  const firstMessage = fakeServer({ thread: { turns: [{ items: [{
    type: 'functionCallOutput', namespace: 'codex_app', name: 'create_thread',
    output: '<codex_delegation><source_thread_id>parent</source_thread_id><input>工具建立的任务</input></codex_delegation>',
  }] }] } });
  const reader = createNamingClient({ appServerFactory: firstMessage.appServerFactory });
  assert.equal(await reader.readFirstPrompt('current'), '工具建立的任务');
  assert.deepEqual(firstMessage.calls.find((call) => call.method === 'thread/read').params,
    { threadId: 'current', includeTurns: true });
  assert.equal(firstMessage.calls.some((call) => call.method === 'model/list'), false);
  await reader.close();
  const wrong = fakeServer({ thread: { id: 'another-task', turns: [{ items: [] }] } });
  const wrongReader = createNamingClient({ appServerFactory: wrong.appServerFactory });
  await assert.rejects(wrongReader.readFirstPrompt('current'), /thread_mismatch/);
  await wrongReader.close();

  for (const thread of [{ ephemeral: true }, { source: { subAgent: 'review' } }, { parentThreadId: 'parent' }]) {
    const stub = fakeServer({ thread });
    assert.deepEqual(await generateName({ sessionId: 'current', prompt: '题目', pluginRoot, appServerFactory: stub.appServerFactory }), { skipped: 'not_main_thread' });
    assert.equal(stub.calls.some((call) => call.method === 'turn/start'), false);
  }
  for (const [models, requested, expected] of [
    [[large], 'auto', 'no_available_model'],
    [[{ ...model, supportedReasoningEfforts: [] }], 'auto', 'no_available_model'],
    [[{ ...model, supportedReasoningEfforts: [] }], model.model, 'no_low_reasoning_effort'],
  ]) {
    const stub = fakeServer({ models });
    assert.deepEqual(await generateName({ sessionId: 'current', prompt: '题目', pluginRoot, model: requested, appServerFactory: stub.appServerFactory }), { skipped: expected });
    assert.equal(stub.calls.some((call) => call.method === 'turn/start'), false);
  }
  assert.deepEqual(await generateName({ prompt: ' ' }), { skipped: 'empty_prompt' });
  assert.deepEqual(await generateName({ prompt: 'x'.repeat(20001) }), { skipped: 'prompt_too_long' });

  for (const spec of [
    { fail: 'thread/start' },
    { output: 'malformed' },
    { items: [{ id: 'tool', type: 'commandExecution' }] },
    { items: [{ id: 'tool', type: 'fileChange' }], finalOnly: true },
    { items: [{ id: 'a', type: 'agentMessage', text: '{}' }, { id: 'b', type: 'agentMessage', text: '{}' }] },
  ]) {
    const stub = fakeServer(spec);
    await assert.rejects(generateName({ sessionId: 'current', prompt: '题目', pluginRoot, appServerFactory: stub.appServerFactory }));
    assert.equal(stub.closed, true);
    assert.equal(fs.existsSync(stub.configuration.cwd), false);
    assert.equal(stub.calls.some((call) => call.method === 'thread/name/set'), false);
  }
  const finalOnly = fakeServer({ finalOnly: true });
  assert.equal((await generateName({ sessionId: 'current', prompt: '题目', pluginRoot, appServerFactory: finalOnly.appServerFactory })).title, '0906｜EXP｜插件审查');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
