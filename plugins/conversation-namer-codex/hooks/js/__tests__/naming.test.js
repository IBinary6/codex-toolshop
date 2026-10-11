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
          id: 'answer', type: 'agentMessage', text: output ?? '{"action":"name","type":"EXP","topic":"\u63d2\u4ef6\u5ba1\u67e5"}',
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
    id: 'gpt-6-luna',
    model: 'gpt-6-luna',
    description: 'Fast and affordable model for everyday work.',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
  };
  const futureLuna = { ...model, id: 'gpt-future-luna', model: 'gpt-future-luna', description: undefined };
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
    'Catalog description low-cost signals should outrank lightweight family fallback');
  assert.equal(selectModel([luna, unknownAffordable]), unknownAffordable,
    'Within a description tier, select the lowest supported reasoning effort');
  assert.equal(selectModel([cheapestLow, cheapestNone]), cheapestNone,
    'Within a low-cost tier, select the lowest supported reasoning effort');
  assert.equal(selectModel([cheapestNone, { ...cheapestNone, id: 'second', model: 'second' }]), cheapestNone,
    'Equal tiers and efforts retain stable catalog order');
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
  assert.equal(selectModel([futureLuna, luna], 'gpt-6-luna'), luna);
  assert.equal(selectModel([futureLuna], 'gpt-6-luna'), null,
    'Do not switch to another model when explicitly requested GPT-6 Luna is unavailable');
  assert.equal(lowestEffort(model), 'none');
  assert.equal(lowestEffort({ supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }), 'low');
  assert.equal(lowestEffort({ supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'low' }] }), 'minimal');
  assert.equal(lowestEffort({ supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }), null);
  assert.equal(lowestEffort({}), null);
  assert.equal(lowestEffort(luna), 'low', 'Do not invent an undeclared none level for Luna');

  const name = (topic, type = 'EXP') => JSON.stringify({ action: 'name', type, topic });
  assert.deepEqual(parseName(name('\u63d2\u4ef6\u5ba1\u67e5'), createdAt, ''), { title: '0906\uff5cEXP\uff5c\u63d2\u4ef6\u5ba1\u67e5' });
  assert.deepEqual(parseName(name('\u63d2\u4ef6\u5ba1\u67e5', '\u63a2\u7d22'), createdAt, ''), { title: '0906\uff5c\u63a2\u7d22\uff5c\u63d2\u4ef6\u5ba1\u67e5' });
  assert.deepEqual(parseName(name('\u8de8\u5e74'), Date.parse('2026-12-31T17:00:00Z') / 1000, ''), { title: '0101\uff5cEXP\uff5c\u8de8\u5e74' });
  for (const invalidDate of [null, undefined, '2026-09-05', -1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(parseName(name('\u65e5\u671f\u7f3a\u5931'), invalidDate, ''), { skipped: 'missing_created_at' });
  }
  assert.deepEqual(parseName('{"action":"skip","type":"","topic":""}', null, ''), { skipped: 'model_skipped' });
  assert.deepEqual(parseName('{"action":"exact","type":"","topic":"\u6211\u7684\u6807\u9898"}', null, '\u6807\u9898\u8bbe\u4e3a\u6211\u7684\u6807\u9898'), { title: '\u6211\u7684\u6807\u9898' });
  assert.throws(() => parseName('{"action":"exact","type":"","topic":"\u51ed\u7a7a\u4ea7\u751f"}', null, '\u5176\u4ed6\u4e3b\u9898'), /invalid_exact_title/);
  for (const invalid of [
    'not-json', '```json\n{}\n```', '[]', 'null', '{}',
    '{"action":"name","type":"EXP","topic":"\u6b63\u5e38","extra":true}',
    name('\u6709\n\u6362\u884c'), name('\u63a7\u5236\u0000\u5b57\u7b26'), name('\u53cc\u5411\u202e\u5b57\u7b26'), name('\u96f6\u5bbd\u200b\u5b57\u7b26'),
    name('\u6709\uff5c\u5206\u9694'), name('\u6709|\u5206\u9694'), name(' \u7a7a\u767d'), name(''), name('a'.repeat(65)), name('\u4e3b\u9898', 'BAD'),
  ]) assert.throws(() => parseName(invalid, createdAt, ''), /invalid_name_output/);

  const fake = fakeServer();
  const client = createNamingClient({ sessionId: 'current', prompt: '\u5ba1\u67e5\u63d2\u4ef6', pluginRoot,
    timeoutMs: 1200, appServerFactory: fake.appServerFactory });
  const result = await client.generateName();
  assert.deepEqual(result, { title: '0906\uff5cEXP\uff5c\u63d2\u4ef6\u5ba1\u67e5', model: model.model, createdAt, originalTitle: 'original' });
  assert.equal(fake.calls.some((call) => call.method === 'thread/name/set'), false, 'Generation must not write the title itself');
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
  assert.deepEqual(turn.input, [{ type: 'text', text: '\u5ba1\u67e5\u63d2\u4ef6' }]);
  assert.equal(turn.effort, 'none');
  assert.equal(turn.summary, 'none');
  assert.deepEqual(turn.environments, []);
  assert.equal(turn.outputSchema.additionalProperties, false);
  for (const [code, label] of [
    ['FEA', '\u529f\u80fd'], ['DES', '\u8bbe\u8ba1'], ['FIX', '\u4fee\u590d'],
    ['OPT', '\u4f18\u5316'], ['REL', '\u53d1\u5e03'], ['EXP', '\u63a2\u7d22'],
    ['DOC', '\u6587\u6863'], ['RES', '\u7814\u7a76'],
  ]) {
    assert.ok(turn.outputSchema.properties.type.enum.includes(label));
    assert.ok(start.developerInstructions.includes(`${code}/${label}`));
  }
  assert.equal((await client.readThreadName('current')).originalTitle, 'original');
  await client.writeThreadName('current', result.title);
  assert.equal((await client.readThreadName('current')).originalTitle, result.title);
  await assert.rejects(client.writeThreadName('current', '\u6807\u9898\n\u6362\u884c'), /invalid_title_write/);
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
        'The naming temporary directory must be removed before close returns');
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
  const lowEffortResult = await generateName({ sessionId: 'current', prompt: '\u5ba1\u67e5\u63d2\u4ef6', pluginRoot,
    appServerFactory: lowEffort.appServerFactory });
  assert.equal(lowEffortResult.model, luna.model);
  assert.equal(lowEffort.calls.find((call) => call.method === 'turn/start').params.effort, 'low');

  const gpt6 = fakeServer({ models: [luna, futureLuna] });
  const gpt6Result = await generateName({ sessionId: 'current', prompt: '\u5ba1\u67e5\u63d2\u4ef6', pluginRoot,
    model: 'gpt-6-luna', appServerFactory: gpt6.appServerFactory });
  assert.equal(gpt6Result.model, 'gpt-6-luna');
  assert.equal(gpt6.calls.find((call) => call.method === 'turn/start').params.model, 'gpt-6-luna');
  assert.equal(gpt6.calls.some((call) => call.method === 'thread/name/set'), false);

  const firstMessage = fakeServer({ thread: { turns: [{ items: [{
    type: 'functionCallOutput', namespace: 'codex_app', name: 'create_thread',
    output: '<codex_delegation><source_thread_id>parent</source_thread_id><input>\u5de5\u5177\u5efa\u7acb\u7684\u4efb\u52a1</input></codex_delegation>',
  }] }] } });
  const reader = createNamingClient({ appServerFactory: firstMessage.appServerFactory });
  assert.equal(await reader.readFirstPrompt('current'), '\u5de5\u5177\u5efa\u7acb\u7684\u4efb\u52a1');
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
    assert.deepEqual(await generateName({ sessionId: 'current', prompt: '\u9898\u76ee', pluginRoot, appServerFactory: stub.appServerFactory }), { skipped: 'not_main_thread' });
    assert.equal(stub.calls.some((call) => call.method === 'turn/start'), false);
  }
  for (const [models, requested, expected] of [
    [[large], 'auto', 'no_available_model'],
    [[{ ...model, supportedReasoningEfforts: [] }], 'auto', 'no_available_model'],
    [[{ ...model, supportedReasoningEfforts: [] }], model.model, 'no_low_reasoning_effort'],
  ]) {
    const stub = fakeServer({ models });
    assert.deepEqual(await generateName({ sessionId: 'current', prompt: '\u9898\u76ee', pluginRoot, model: requested, appServerFactory: stub.appServerFactory }), { skipped: expected });
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
    await assert.rejects(generateName({ sessionId: 'current', prompt: '\u9898\u76ee', pluginRoot, appServerFactory: stub.appServerFactory }));
    assert.equal(stub.closed, true);
    assert.equal(fs.existsSync(stub.configuration.cwd), false);
    assert.equal(stub.calls.some((call) => call.method === 'thread/name/set'), false);
  }
  const finalOnly = fakeServer({ finalOnly: true });
  assert.equal((await generateName({ sessionId: 'current', prompt: '\u9898\u76ee', pluginRoot, appServerFactory: finalOnly.appServerFactory })).title, '0906\uff5cEXP\uff5c\u63d2\u4ef6\u5ba1\u67e5');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
