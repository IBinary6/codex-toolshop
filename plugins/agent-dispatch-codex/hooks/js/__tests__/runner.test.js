'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = path.resolve(__dirname, '..', '..', '..', 'scripts', 'run-hook.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dispatch-runner-'));
const data = path.join(root, 'data');
const hook = path.join(root, 'hooks', 'js', 'session_start.js');
fs.mkdirSync(path.dirname(hook), { recursive: true });

function invoke(source, { input = '{}', env = {}, name = 'session_start' } = {}) {
  fs.writeFileSync(hook, source);
  return spawnSync(process.execPath, [runner, name], {
    cwd: root, input, encoding: 'utf8', windowsHide: process.platform === 'win32',
    env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data, ...env },
  });
}

try {
  // The hook runs as this process's entry point: no second Node, require.main intact, stdin untouched.
  const probe = `
    const fs = require('fs');
    process.stdout.write(JSON.stringify({ pid: process.pid, main: require.main === module,
      argv1: process.argv[1], root: process.env.PLUGIN_ROOT, data: process.env.PLUGIN_DATA,
      stdin: fs.readFileSync(0, 'utf8') }));`;
  const ran = invoke(probe, { input: '{"hello":"world"}' });
  assert.equal(ran.status, 0, ran.stderr);
  const seen = JSON.parse(ran.stdout);
  assert.equal(seen.pid, ran.pid, 'hook shares the runner process');
  assert.equal(seen.main, true, 'require.main guards still fire');
  assert.equal(seen.argv1, hook);
  assert.equal(seen.root, root);
  assert.equal(seen.data, data);
  assert.equal(seen.stdin, '{"hello":"world"}', 'the hook reads the original stdin');
  assert.ok(fs.existsSync(data), 'the plugin data directory is created');

  // TOOLSHOP_HOOKS_CHILD_PROCESS=1 restores the previous child-process model with identical behavior.
  const child = invoke(probe, { input: '{"a":1}', env: { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' } });
  assert.equal(child.status, 0, child.stderr);
  const childSeen = JSON.parse(child.stdout);
  assert.notEqual(childSeen.pid, child.pid, 'kill switch runs the hook in a child process');
  assert.equal(childSeen.stdin, '{"a":1}');
  assert.equal(childSeen.main, true);

  // A failing hook must never fail the task, in either model.
  for (const env of [{}, { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' }]) {
    for (const [label, source, message] of [
      ['throw at load', 'throw new Error("boom");', /boom/],
      ['async rejection', 'Promise.reject(new Error("late boom"));', /late boom/],
      ['non-zero exit code', 'process.exitCode = 3;', null],
      ['explicit exit', 'process.exit(4);', null],
    ]) {
      const failed = invoke(source, { env });
      assert.equal(failed.status, 0, `${label}: ${failed.stderr}`);
      if (message && !env.TOOLSHOP_HOOKS_CHILD_PROCESS) assert.match(failed.stderr, message, label);
    }
  }
  const exited = invoke('process.exit(4);');
  assert.match(exited.stderr, /hook exited with status 4/);

  const missing = spawnSync(process.execPath, [runner, 'no_such_hook'], { encoding: 'utf8', env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data } });
  assert.equal(missing.status, 0);
  assert.match(missing.stderr, /unknown hook: no_such_hook/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('runner.test.js PASS');
