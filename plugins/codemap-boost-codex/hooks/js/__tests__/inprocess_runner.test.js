'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = path.resolve(__dirname, '../../../scripts/run-hook.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-inprocess-'));
const data = path.join(root, 'data');
fs.mkdirSync(path.join(root, 'hooks/js'), { recursive: true });

function invoke(name, source, { input = '{}', env = {} } = {}) {
  fs.writeFileSync(path.join(root, 'hooks/js', `${name}.js`), source);
  return spawnSync(process.execPath, [runner, name], {
    cwd: root, input, encoding: 'utf8', windowsHide: process.platform === 'win32',
    env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data, ...env },
  });
}

try {
  // Ordinary hooks run as this process's entry point: no second Node, require.main intact, stdin untouched.
  const probe = `
    const fs = require('fs');
    process.stdout.write(JSON.stringify({ pid: process.pid, main: require.main === module,
      argv1: process.argv[1], root: process.env.PLUGIN_ROOT, data: process.env.PLUGIN_DATA,
      stdin: fs.readFileSync(0, 'utf8') }));`;
  for (const name of ['session_start', 'post_tool_use', 'pre_code_search', 'user_prompt_submit', 'subagent_start']) {
    const ran = invoke(name, probe, { input: '{"hello":"world"}' });
    assert.equal(ran.status, 0, `${name}: ${ran.stderr}`);
    const seen = JSON.parse(ran.stdout);
    assert.equal(seen.pid, ran.pid, `${name} shares the runner process`);
    assert.equal(seen.main, true, `${name}: require.main guards still fire`);
    assert.equal(seen.argv1, path.join(root, 'hooks/js', `${name}.js`));
    assert.equal(seen.root, root);
    assert.equal(seen.data, data);
    assert.equal(seen.stdin, '{"hello":"world"}');
  }
  assert.equal(fs.existsSync(data), false, 'the runner alone must not create plugin state');

  // The graph barrier stays supervised in a child process so it can fail closed without partial output.
  const barrier = invoke('pre_graph_tool', probe);
  assert.equal(barrier.status, 0, barrier.stderr);
  assert.notEqual(JSON.parse(barrier.stdout).pid, barrier.pid, 'pre_graph_tool keeps a supervising parent');

  // TOOLSHOP_HOOKS_CHILD_PROCESS=1 restores the previous child-process model with identical behavior.
  const child = invoke('session_start', probe, { input: '{"a":1}', env: { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' } });
  assert.equal(child.status, 0, child.stderr);
  assert.notEqual(JSON.parse(child.stdout).pid, child.pid, 'kill switch runs the hook in a child process');
  assert.equal(JSON.parse(child.stdout).stdin, '{"a":1}');

  // A failing ordinary hook must never fail the task. In-process runs also say why on stderr.
  for (const [label, source, message] of [
    ['throw at load', 'throw new Error("boom");', /hook failed: boom/],
    ['async rejection', 'Promise.reject(new Error("late boom"));', /hook failed: late boom/],
    ['non-zero exit code', 'process.exitCode = 3;', /hook exited with status 3/],
    ['explicit exit', 'process.exit(4);', /hook exited with status 4/],
  ]) {
    const failed = invoke('session_start', source);
    assert.equal(failed.status, 0, `${label}: ${failed.stderr}`);
    assert.match(failed.stderr, message, label);
    const viaChild = invoke('session_start', source, { env: { TOOLSHOP_HOOKS_CHILD_PROCESS: '1' } });
    assert.equal(viaChild.status, 0, `${label} (child process): ${viaChild.stderr}`);
  }

  const missing = invoke('no_such_hook', '');
  assert.equal(missing.status, 0);
  assert.match(missing.stderr, /unknown hook: no_such_hook/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('inprocess_runner.test.js PASS');
