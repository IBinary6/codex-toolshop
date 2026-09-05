'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = path.resolve(__dirname, '../../../scripts/run-hook.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-runner-'));
try {
  const hook = path.join(tmp, 'hooks/js/pre_graph_tool.js');
  const data = path.join(tmp, 'data');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  const invoke = () => spawnSync(process.execPath, [runner, 'pre_graph_tool'], {
    cwd: tmp, env: { ...process.env, PLUGIN_ROOT: tmp, PLUGIN_DATA: data },
    input: '{}', encoding: 'utf8', windowsHide: process.platform === 'win32',
  });
  for (const source of [
    'throw new Error("fixture failure");',
    'process.stdout.write("partial output"); process.exit(1);',
  ]) {
    fs.writeFileSync(hook, source);
    const result = invoke();
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
  fs.rmSync(hook);
  assert.equal(JSON.parse(invoke().stdout).hookSpecificOutput.permissionDecision, 'deny');
  fs.writeFileSync(hook, 'process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:"allow"}}));');
  assert.equal(JSON.parse(invoke().stdout).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(fs.existsSync(data), false, 'runner alone must not create plugin state');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('runner.test.js PASS');
