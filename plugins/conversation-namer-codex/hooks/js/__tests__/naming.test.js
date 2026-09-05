'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const { createNamingClient, generateName, lowestEffort, parseName, selectModel } = require('../lib/naming');

const pluginRoot = path.resolve(__dirname, '..', '..', '..');
const createdAt = Date.parse('2026-09-05T18:30:00Z') / 1000;
const model = {
  id: 'future-mini', model: 'gpt-future-mini', hidden: false,
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
  const luna = { ...model, id: 'future-luna', model: 'gpt-future-luna' };
  const spark = { ...model, id: 'future-spark', model: 'gpt-future-codex-spark' };
  const large = { ...model, id: 'large', model: 'gpt-large' };
  assert.equal(selectModel([model, luna, spark]), spark);
  assert.equal(selectModel([model, luna]), model);
  assert.equal(selectModel([spark, luna]), spark);
  assert.equal(selectModel([luna]), luna);
  assert.equal(selectModel([spark]), spark);
  const highOnlyMini = { ...model, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
  assert.equal(selectModel([highOnlyMini, luna, spark]), spark);
  assert.equal(selectModel([highOnlyMini, luna]), luna);
  assert.equal(selectModel([{ ...spark, hidden: true }, model, luna]), model);
  assert.equal(selectModel([{ ...spark, supportedReasoningEfforts: [] }, model, luna]), model);
  assert.equal(selectModel([highOnlyMini, spark]), spark);
  assert.equal(selectModel([highOnlyMini, model]), model);
  assert.equal(selectModel([highOnlyMini]), null);
  assert.equal(selectModel([large]), null);
  assert.equal(selectModel([{ ...model, hidden: true }]), null);
  assert.equal(selectModel([{ ...model, inputModalities: ['audio'] }]), null);
  assert.equal(selectModel([model], 'missing-model'), null);
  assert.equal(selectModel([model], model.id), model);
  assert.equal(lowestEffort(model), 'none');
  assert.equal(lowestEffort({ supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }), 'low');
  assert.equal(lowestEffort({ supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'low' }] }), 'minimal');
  assert.equal(lowestEffort({ supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }), null);
  assert.equal(lowestEffort({}), null);

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
