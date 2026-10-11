'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { armSession, claimSession, readState, loadConfig, stateFile } = require('../lib/state');
const { queueNaming } = require('../user_prompt_submit');
const { nameSession } = require('../name_worker');
const { main: sessionStart } = require('../session_start');

const pluginRoot = path.resolve(__dirname, '..', '..', '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-namer-hooks-'));
const env = { ...process.env, PLUGIN_DATA: temporary, PLUGIN_ROOT: pluginRoot };
delete env.CONVERSATION_NAMER_WORKER;
let observations = 0;

function runHook(name, input) {
  if (name === 'session_start' && input.source === 'startup') {
    let output = '';
    sessionStart(input, { env,
      observe() { observations += 1; },
      writeContext(hookEventName, additionalContext) {
        output = JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } });
      },
    });
    return output;
  }
  const result = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/run-hook.cjs'), name], {
    cwd: pluginRoot, env, input: JSON.stringify(input), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function main() {
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const sessionId = `task-${source}`;
    const result = JSON.parse(runHook('session_start', { source, session_id: sessionId }));
    assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(result.hookSpecificOutput.additionalContext, new RegExp(sessionId));
    assert.doesNotMatch(result.hookSpecificOutput.additionalContext,
      /set_thread_title|read_thread|assistant turn|gate|title policy/i);
    assert.equal(readState(sessionId, env)?.status, source === 'startup' ? 'pending' : undefined);
  }
  assert.equal(runHook('session_start', { source: 'startup', session_id: '../bad' }), '');
  runHook('session_start', { source: 'startup', session_id: 'task-startup' });
  assert.equal(observations, 1, 'Only the first startup launches an observer; repeated startup and resume do not');
  assert.equal(runHook('user_prompt_submit', { session_id: 'old-task', prompt: '\u540e\u7eed\u6d88\u606f' }), '');
  assert.equal(runHook('user_prompt_submit', { session_id: 'task-startup', prompt: '' }), '');
  assert.equal(readState('task-startup', env).status, 'skipped');

  // Opening commentary does not affect state; only startup and the first user message trigger naming once.
  armSession({ source: 'startup', session_id: 'first-task' }, env);
  let launches = 0;
  let delivered;
  let detached = false;
  const spawnWorker = (command, args, options) => {
    launches += 1;
    assert.equal(command, process.execPath);
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ['pipe', 'ignore', 'ignore']);
    return { on() {}, unref() { detached = true; }, stdin: {
      on() {}, end(text, callback) { delivered = JSON.parse(text); callback(); },
    } };
  };
  queueNaming({ session_id: 'first-task', prompt: '\u4fee\u590d\u767b\u5f55\u9519\u8bef $(echo secret)' }, { env, spawnWorker });
  queueNaming({ session_id: 'first-task', prompt: '\u8fd9\u662f\u540e\u7eed\u6d88\u606f' }, { env, spawnWorker });
  armSession({ source: 'startup', session_id: 'first-task' }, env);
  queueNaming({ session_id: 'first-task', prompt: '\u91cd\u590d\u542f\u52a8' }, { env, spawnWorker });
  assert.equal(launches, 1);
  assert.equal(detached, true);
  assert.deepEqual(delivered, { sessionId: 'first-task', prompt: '\u4fee\u590d\u767b\u5f55\u9519\u8bef $(echo secret)' });
  assert.doesNotMatch(fs.readFileSync(stateFile('first-task', env), 'utf8'), /secret|prompt/);
  assert.equal(claimSession('first-task', env), false);
  armSession({ source: 'startup', session_id: 'recursive' }, { ...env, CONVERSATION_NAMER_WORKER: '1' });
  assert.equal(readState('recursive', env), null);

  // Write even if the host assigns a default title during inference; also verify deduplication, failure, and user skips.
  for (const scenario of ['normal', 'changed', 'same', 'model-failed', 'write-failed', 'skip']) {
    const sessionId = `result-${scenario}`;
    armSession({ source: 'startup', session_id: sessionId }, env);
    claimSession(sessionId, env);
    const title = '0905\uff5cFIX\uff5c\u767b\u5f55\u9519\u8bef';
    let current = scenario === 'changed' ? '\u5bbf\u4e3b\u751f\u6210\u7684\u9ed8\u8ba4\u6807\u9898' : scenario === 'same' ? title : '\u65e7\u6807\u9898';
    let writes = 0;
    let closes = 0;
    const clientFactory = () => ({
      async generateName(input) {
        assert.equal(input.sessionId, sessionId);
        if (scenario === 'model-failed') throw new Error('secret service payload');
        if (scenario === 'skip') return { skipped: 'user_intent' };
        return { title, model: 'test-mini', originalTitle: '\u65e7\u6807\u9898' };
      },
      async readThreadName(id) { assert.equal(id, sessionId); return { originalTitle: current }; },
      async writeThreadName(id, value) {
        assert.equal(id, sessionId);
        writes += 1;
        if (scenario !== 'write-failed') current = value;
      },
      async close() { closes += 1; },
    });
    await nameSession({ sessionId, prompt: '\u4fee\u590d\u767b\u5f55\u9519\u8bef' }, { env, clientFactory });
    const expected = {
      normal: 'done', changed: 'done', same: 'done', 'model-failed': 'failed',
      'write-failed': 'failed', skip: 'skipped',
    };
    assert.equal(readState(sessionId, env).status, expected[scenario]);
    assert.equal(writes, ['normal', 'changed', 'write-failed'].includes(scenario) ? 1 : 0);
    if (expected[scenario] === 'done') assert.equal(current, title);
    assert.equal(closes, 1);
    assert.equal(claimSession(sessionId, env), false);
    assert.doesNotMatch(fs.readFileSync(stateFile(sessionId, env), 'utf8'), /secret|prompt/);
  }
  assert.deepEqual(loadConfig(env), { model: 'gpt-6-luna', timeoutMs: 60000 });
  fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify({ model: 'auto' }));
  assert.deepEqual(loadConfig(env), { model: 'auto', timeoutMs: 60000 });
  fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify({ model: 'test-luna', timeoutSeconds: 15 }));
  assert.deepEqual(loadConfig(env), { model: 'test-luna', timeoutMs: 15000 });
  fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify({ timeoutSeconds: 0 }));
  assert.throws(() => loadConfig(env), /Invalid/);
}

main().finally(() => fs.rmSync(temporary, { recursive: true, force: true }))
  .catch((error) => { console.error(error); process.exitCode = 1; });
