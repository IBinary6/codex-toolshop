'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = path.resolve(__dirname, '..', 'scripts', 'run-hook.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-knowledge-inprocess-'));
fs.mkdirSync(path.join(root, 'hooks', 'js'), { recursive: true });
const HOOK_FILES = {
  session_start: 'local_knowledge_session.js',
  post_tool_use: 'local_knowledge_check.js',
  user_prompt_submit: 'local_knowledge_prompt.js',
};

function invoke(name, source, { input = '{}', env = {} } = {}) {
  fs.writeFileSync(path.join(root, 'hooks', 'js', HOOK_FILES[name]), source);
  return spawnSync(process.execPath, [runner, name], {
    cwd: root, input, encoding: 'utf8', windowsHide: process.platform === 'win32',
    env: { ...process.env, PLUGIN_ROOT: root, ...env },
  });
}

try {
  // Hooks run as this process's entry point: no second Node, require.main intact, stdin untouched.
  const probe = `
    const fs = require('fs');
    process.stdout.write(JSON.stringify({ pid: process.pid, main: require.main === module,
      argv1: process.argv[1], root: process.env.PLUGIN_ROOT, stdin: fs.readFileSync(0, 'utf8') }));`;
  for (const name of Object.keys(HOOK_FILES)) {
    const ran = invoke(name, probe, { input: '{"hello":"world"}' });
    assert.equal(ran.status, 0, `${name}: ${ran.stderr}`);
    const seen = JSON.parse(ran.stdout);
    assert.equal(seen.pid, ran.pid, `${name} shares the runner process`);
    assert.equal(seen.main, true, `${name}: require.main guards still fire`);
    assert.equal(seen.argv1, path.join(root, 'hooks', 'js', HOOK_FILES[name]));
    assert.equal(seen.root, root);
    assert.equal(seen.stdin, '{"hello":"world"}');
  }

  // TOOLSHOP_HOOKS_CHILD_PROCESS=1 restores the previous child-process model with identical behavior.
  const child = invoke('session_start', probe, { input: '{"a":1}', env: { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' } });
  assert.equal(child.status, 0, child.stderr);
  assert.notEqual(JSON.parse(child.stdout).pid, child.pid, 'kill switch runs the hook in a child process');
  assert.equal(JSON.parse(child.stdout).stdin, '{"a":1}');

  // A failing hook must never fail the task, in either model.
  for (const env of [{}, { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' }]) {
    for (const [label, source, message] of [
      ['throw at load', 'throw new Error("boom");', /boom/],
      ['async rejection', 'Promise.reject(new Error("late boom"));', /late boom/],
      ['non-zero exit code', 'process.exitCode = 3;', null],
      ['explicit exit', 'process.exit(4);', null],
    ]) {
      const failed = invoke('session_start', source, { env });
      assert.equal(failed.status, 0, `${label}: ${failed.stderr}`);
      if (message && !env.TOOLSHOP_HOOKS_CHILD_PROCESS) assert.match(failed.stderr, message, label);
    }
  }

  // A hook that never finishes is cut off at its own timeout, before the host timeout, without failing the task.
  const { HOOK_TIMEOUT_MS } = require(runner);
  const hanging = 'setInterval(() => {}, 1000);';
  fs.writeFileSync(path.join(root, 'hooks', 'js', HOOK_FILES.post_tool_use), hanging);
  const started = Date.now();
  const cut = spawnSync(process.execPath, [runner, 'post_tool_use'], {
    cwd: root, input: '{}', encoding: 'utf8', windowsHide: process.platform === 'win32',
    env: { ...process.env, PLUGIN_ROOT: root },
  });
  assert.equal(cut.status, 0);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= HOOK_TIMEOUT_MS.post_tool_use - 100 && elapsed < HOOK_TIMEOUT_MS.post_tool_use + 3000,
    `hung hook is cut off near ${HOOK_TIMEOUT_MS.post_tool_use} ms, took ${elapsed} ms`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('inprocess-runner.test.js PASS');
