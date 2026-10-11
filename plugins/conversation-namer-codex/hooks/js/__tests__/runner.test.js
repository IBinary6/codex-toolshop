'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

  // Every hook, including desktop_delivery on PostToolUse and Stop, runs as the runner's own entry point:
  // no second Node, require.main guards still fire, and the hook reads the original stdin.
  for (const name of ['session_start', 'user_prompt_submit', 'desktop_delivery']) {
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

  // A failing hook must never fail the task. In-process runs also say why on stderr.
  for (const [label, source, message] of [
    ['throw at load', 'throw new Error("boom");', /hook failed: boom/],
    ['async rejection', 'Promise.reject(new Error("late boom"));', /hook failed: late boom/],
    ['non-zero exit code', 'process.exitCode = 3;', /hook exited with status 3/],
    ['explicit exit', 'process.exit(4);', /hook exited with status 4/],
  ]) {
    const failed = invoke('user_prompt_submit', source);
    assert.equal(failed.status, 0, `${label}: ${failed.stderr}`);
    assert.match(failed.stderr, message, label);
    const viaChild = invoke('user_prompt_submit', source, { extra: { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' } });
    assert.equal(viaChild.status, 0, `${label} (child process): ${viaChild.stderr}`);
    if (label.startsWith('non-zero') || label.startsWith('explicit')) assert.match(viaChild.stderr, message, `${label} (child process)`);
  }

  const missing = invoke('no_such_hook', '');
  assert.equal(missing.status, 0);
  assert.match(missing.stderr, /unknown hook: no_such_hook/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('runner.test.js PASS');
