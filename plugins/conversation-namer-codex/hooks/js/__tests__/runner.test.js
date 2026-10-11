'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { armSession, writeState } = require('../lib/state');

const runner = path.resolve(__dirname, '..', '..', '..', 'scripts', 'run-hook.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'namer-runner-'));
const data = path.join(root, 'data');
const env = { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data };
delete env.CONVERSATION_NAMER_WORKER;
fs.mkdirSync(path.join(root, 'hooks', 'js'), { recursive: true });

function invoke(name, source, { input = '{}', extra = {} } = {}) {
  fs.writeFileSync(path.join(root, 'hooks', 'js', `${name}.js`), source);
  return spawnSync(process.execPath, [runner, name], {
    cwd: root, input, encoding: 'utf8', windowsHide: process.platform === 'win32',
    env: { ...env, ...extra },
  });
}

try {
  const probe = `
    const fs = require('fs');
    process.stdout.write(JSON.stringify({ pid: process.pid, main: require.main === module,
      root: process.env.PLUGIN_ROOT, stdin: fs.readFileSync(0, 'utf8') }));`;

  // Hooks that do not inspect stdin run as the runner's own entry point: no second Node.
  for (const name of ['session_start', 'user_prompt_submit']) {
    const ran = invoke(name, probe, { input: '{"hello":"world"}' });
    assert.equal(ran.status, 0, `${name}: ${ran.stderr}`);
    const seen = JSON.parse(ran.stdout);
    assert.equal(seen.pid, ran.pid, `${name} shares the runner process`);
    assert.equal(seen.main, true, `${name}: require.main guards still fire`);
    assert.equal(seen.root, root);
    assert.equal(seen.stdin, '{"hello":"world"}');
  }

  // TOOLSHOP_HOOKS_CHILD_PROCESS=1 restores the previous child-process model with identical behavior.
  const child = invoke('session_start', probe, { input: '{"a":1}', extra: { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' } });
  assert.equal(child.status, 0, child.stderr);
  assert.notEqual(JSON.parse(child.stdout).pid, child.pid);
  assert.equal(JSON.parse(child.stdout).stdin, '{"a":1}');

  // A failing hook must never fail the task, in either model.
  for (const extra of [{}, { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' }]) {
    for (const [label, source] of [
      ['throw at load', 'throw new Error("boom");'],
      ['async rejection', 'Promise.reject(new Error("late boom"));'],
      ['non-zero exit code', 'process.exitCode = 3;'],
      ['explicit exit', 'process.exit(4);'],
    ]) {
      const failed = invoke('user_prompt_submit', source, { extra });
      assert.equal(failed.status, 0, `${label}: ${failed.stderr}`);
    }
  }
  assert.match(invoke('user_prompt_submit', 'throw new Error("boom");').stderr, /hook failed: boom/);

  // desktop_delivery stays out of the way on PostToolUse until a title is ready, then runs in a child process
  // that receives the original input.
  const postTool = (session) => JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash' });
  const idle = invoke('desktop_delivery', probe, { input: postTool('never-armed') });
  assert.equal(idle.status, 0, idle.stderr);
  assert.equal(idle.stdout, '', 'no state: the hook is not started');
  armSession({ source: 'startup', session_id: 'ready-session' }, env);
  writeState('ready-session', { status: 'ready', delivery: 'desktop', title: 'A title', model: 'test' }, env);
  const active = invoke('desktop_delivery', probe, { input: postTool('ready-session') });
  assert.equal(active.status, 0, active.stderr);
  const activeSeen = JSON.parse(active.stdout);
  assert.notEqual(activeSeen.pid, active.pid);
  assert.equal(JSON.parse(activeSeen.stdin).session_id, 'ready-session');
  const stop = invoke('desktop_delivery', probe, { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'never-armed' }) });
  assert.ok(stop.stdout.includes('"pid"'), 'Stop always runs the hook');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('runner.test.js PASS');
