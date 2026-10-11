'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { armSession, claimSession, readState, stateFile } = require('../lib/state');
const { observeStartup, queueStartupObservation } = require('../startup_observer');
const { queueNaming } = require('../user_prompt_submit');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'namer-observer-'));
const env = { ...process.env, PLUGIN_DATA: temporary };
delete env.CONVERSATION_NAMER_WORKER;

function arm(sessionId) { armSession({ session_id: sessionId, source: 'startup' }, env); }

function fakeClient(read) {
  const count = { reads: 0, generations: 0, writes: 0, closes: 0 };
  let title = '\u5de5\u5177\u4f20\u5165\u7684\u9ed8\u8ba4\u6807\u9898';
  return {
    count,
    async readFirstPrompt(id) { count.reads += 1; return read(id, count.reads); },
    async generateName({ prompt }) {
      count.generations += 1;
      assert.equal(prompt, '\u89e3\u91ca RAII');
      return { title: '0905\uff5cEXP\uff5c\u7406\u89e3 RAII', model: 'test-spark' };
    },
    async readThreadName() { return { originalTitle: title }; },
    async writeThreadName(id, value) { count.writes += 1; title = value; },
    async close() { count.closes += 1; },
  };
}

async function main() {
  arm('delayed');
  const client = fakeClient((id, reads) => {
    assert.equal(id, 'delayed');
    if (reads === 1) throw new Error('app_server_rpc_failed');
    return reads === 2 ? null : '\u89e3\u91ca RAII';
  });
  await observeStartup({ sessionId: 'delayed' }, { env, clientFactory: () => client, sleep: async () => {} });
  assert.equal(readState('delayed', env).status, 'done');
  assert.deepEqual(client.count, { reads: 3, generations: 1, writes: 1, closes: 1 });
  assert.doesNotMatch(fs.readFileSync(stateFile('delayed', env), 'utf8'), /\u89e3\u91ca RAII|prompt/);
  assert.equal(await observeStartup({ sessionId: 'delayed' }, { env }), 'inactive');

  // If the regular first message claims naming during observation, the observer must not call the model.
  arm('manual-wins');
  let manualLaunches = 0;
  const manualClient = fakeClient(() => {
    queueNaming({ session_id: 'manual-wins', prompt: '\u89e3\u91ca RAII' }, { env,
      spawnWorker() {
        manualLaunches += 1;
        return { on() {}, unref() {}, stdin: { on() {}, end(value, done) { done(); } } };
      },
    });
    return '\u89e3\u91ca RAII';
  });
  assert.equal(await observeStartup({ sessionId: 'manual-wins' }, {
    env, clientFactory: () => manualClient,
  }), 'claimed_elsewhere');
  assert.equal(manualLaunches, 1);
  assert.equal(manualClient.count.generations, 0);
  assert.equal(manualClient.count.closes, 1);

  // An empty startup exits within its bound and preserves naming for the later first message.
  arm('no-prompt');
  const empty = fakeClient(() => null);
  assert.equal(await observeStartup({ sessionId: 'no-prompt' }, {
    env, clientFactory: () => empty, timeoutMs: 15,
  }), 'timeout');
  assert.equal(readState('no-prompt', env).status, 'pending');
  assert.equal(claimSession('no-prompt', env), true);
  assert.equal(empty.count.generations, 0);

  // Close the client at the hard deadline if the request stalls; do not wait indefinitely.
  arm('hung-read');
  let rejectRead;
  const hung = fakeClient(() => new Promise((resolve, reject) => { rejectRead = reject; }));
  hung.close = async () => { rejectRead?.(new Error('app_server_closed')); };
  assert.equal(await observeStartup({ sessionId: 'hung-read' }, {
    env, clientFactory: () => hung, timeoutMs: 15,
  }), 'unavailable');
  assert.equal(readState('hung-read', env).status, 'pending');

  // Generation after claiming must obey the configured timeout rather than reuse the observer remaining time.
  arm('hung-generation');
  fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify({ timeoutSeconds: 5 }));
  let rejectGeneration;
  const stalled = fakeClient(() => '\u89e3\u91ca RAII');
  stalled.generateName = () => new Promise((resolve, reject) => { rejectGeneration = reject; });
  stalled.close = async () => { rejectGeneration?.(new Error('app_server_closed')); };
  assert.equal(await observeStartup({ sessionId: 'hung-generation' }, {
    env, clientFactory: () => stalled,
  }), 'attempted');
  assert.equal(readState('hung-generation', env).status, 'failed');
  assert.equal(claimSession('hung-generation', env), false);
  fs.rmSync(path.join(temporary, 'config.json'));

  // Background launch carries no prompt, injects nothing into the main model, and retains the recursion suppression marker.
  let queued = 0;
  queueStartupObservation('launch', { env, spawnWorker(command, args, options) {
    queued += 1;
    assert.equal(command, process.execPath);
    assert.equal(options.detached, true);
    assert.equal(options.env.CONVERSATION_NAMER_WORKER, '1');
    assert.deepEqual(options.stdio, ['pipe', 'ignore', 'ignore']);
    return { on() {}, unref() {}, stdin: {
      on() {}, end(value, done) { assert.deepEqual(JSON.parse(value), { sessionId: 'launch' }); done(); },
    } };
  } });
  queueStartupObservation('launch', { env: { ...env, CONVERSATION_NAMER_WORKER: '1' },
    spawnWorker() { throw new Error('must not recursively launch'); },
  });
  assert.equal(queued, 1);

  // Two independent processes claiming the same session must yield only one winner.
  arm('process-race');
  const claimCode = "const {claimSession}=require(process.argv[1]);process.stdout.write(String(claimSession('process-race')));";
  const launchClaim = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', claimCode, path.resolve(__dirname, '../lib/state.js')], {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error('claim process failed')));
  });
  assert.deepEqual((await Promise.all([launchClaim(), launchClaim()])).sort(), ['false', 'true']);
  assert.equal(readState('process-race', env).status, 'started');
  assert.ok(!fs.readdirSync(path.join(temporary, 'sessions')).some((name) => name.endsWith('.tmp')));
}

main().finally(() => fs.rmSync(temporary, { recursive: true, force: true }))
  .catch((error) => { console.error(error); process.exitCode = 1; });
