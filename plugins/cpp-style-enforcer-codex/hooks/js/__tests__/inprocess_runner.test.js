'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = path.resolve(__dirname, '..', '..', '..', 'scripts', 'run-hook.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-style-inprocess-'));
const data = path.join(root, 'data');
fs.mkdirSync(path.join(root, 'hooks', 'js'), { recursive: true });

function invoke(name, source, { input = '{}', env = {} } = {}) {
  fs.writeFileSync(path.join(root, 'hooks', 'js', `${name}.js`), source);
  return spawnSync(process.execPath, [runner, name], {
    cwd: root, input, encoding: 'utf8', windowsHide: process.platform === 'win32',
    env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data, ...env },
  });
}

try {
  // Hooks run as this process's entry point: no second Node, require.main intact, stdin untouched.
  const probe = `
    const fs = require('fs');
    process.stdout.write(JSON.stringify({ pid: process.pid, main: require.main === module,
      argv1: process.argv[1], root: process.env.PLUGIN_ROOT, data: process.env.PLUGIN_DATA,
      stdin: fs.readFileSync(0, 'utf8') }));`;
  for (const name of ['session_start', 'post_edit', 'stop_check', 'pre_commit']) {
    const ran = invoke(name, probe, { input: '{"hello":"world"}' });
    assert.strictEqual(ran.status, 0, `${name}: ${ran.stderr}`);
    const seen = JSON.parse(ran.stdout);
    assert.strictEqual(seen.pid, ran.pid, `${name} shares the runner process`);
    assert.strictEqual(seen.main, true, `${name}: require.main guards still fire`);
    assert.strictEqual(seen.argv1, path.join(root, 'hooks', 'js', `${name}.js`));
    assert.strictEqual(seen.root, root);
    assert.strictEqual(seen.data, data);
    // session_start never reads its input, so the runner consumes it first (see the EPIPE check below).
    assert.strictEqual(seen.stdin, name === 'session_start' ? '' : '{"hello":"world"}');
  }
  assert.ok(fs.existsSync(data), 'the plugin data directory is created');

  // TOOLSHOP_HOOKS_CHILD_PROCESS=1 restores the previous child-process model with identical behavior.
  const child = invoke('post_edit', probe, { input: '{"a":1}', env: { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' } });
  assert.strictEqual(child.status, 0, child.stderr);
  assert.notStrictEqual(JSON.parse(child.stdout).pid, child.pid, 'kill switch runs the hook in a child process');
  assert.strictEqual(JSON.parse(child.stdout).stdin, '{"a":1}');

  // The hook's own exit status is kept in both models: exit 2 blocks the action being checked.
  for (const env of [{}, { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' }]) {
    assert.strictEqual(invoke('pre_commit', 'process.stdout.write("denied"); process.exit(2);', { env }).status, 2);
    assert.strictEqual(invoke('pre_commit', 'process.exitCode = 3;', { env }).status, 3);
    const crashed = invoke('pre_commit', 'throw new Error("boom");', { env });
    assert.strictEqual(crashed.status, 1, 'an unexpected crash is not reported as success');
    assert.match(crashed.stderr, /boom/);
  }
  // A hook that never reads its input must not leave the host writing into a closed pipe.
  for (const env of [{}, { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' }]) {
    const ignoring = invoke('session_start', 'process.stdout.write("ok");', { input: 'x'.repeat(1 << 20), env });
    assert.strictEqual(ignoring.error, undefined, `host write must not fail: ${ignoring.error && ignoring.error.code}`);
    assert.strictEqual(ignoring.status, 0);
    assert.strictEqual(ignoring.stdout, 'ok');
  }
  const unknown = spawnSync(process.execPath, [runner, 'no_such_hook'], { encoding: 'utf8', env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data } });
  assert.strictEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown hook: no_such_hook/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('inprocess_runner.test.js PASS');
