'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runCpplint } = require('../steps/cpplint');
const plugin = path.resolve(__dirname, '../../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-third-party-'));
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { cwd: tmp, encoding: 'utf8', windowsHide: true, ...options });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function hook(name, input) {
  return run(process.execPath, [path.join(plugin, 'scripts/run-hook.cjs'), name], {
    input: JSON.stringify({ cwd: tmp, session_id: 'third-party', ...input }),
    env: { ...process.env, PLUGIN_ROOT: plugin, PLUGIN_DATA: path.join(tmp, 'hook-data') },
  });
}
try {
  run('git', ['init', '-q']);
  fs.mkdirSync(path.join(tmp, '.codex-cpp-style'));
  fs.writeFileSync(path.join(tmp, '.codex-cpp-style/cpp-style.json'), JSON.stringify({
    mode: 'full', copyrightInfo: { company: 'Example' },
    checks: { clangFormat: true, copyright: true, cpplint: true, bom: true },
  }));
  fs.writeFileSync(path.join(tmp, 'app.vcxproj'), '<Project />');
  const bad = Buffer.from('int  f( ) { double d = 1.5; return (int)d; }');
  for (const name of ['3rd', 'thridpart', 'Third-Party', 'vendor']) {
    const file = path.join(tmp, name, 'lib.cpp');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, bad);
    assert.deepEqual(runCpplint(file, { resolvePython() { throw new Error('Must not launch lint'); } }), []);
    assert.equal(hook('post_edit', { turn_id: name, tool_input: { file_path: file } }), '');
    assert.deepEqual(JSON.parse(hook('stop_check', { turn_id: name })), {});
    assert.deepEqual(fs.readFileSync(file), bad, '不格式化、加 BOM、版权头或 CRLF');
    run('git', ['add', '--', name + '/lib.cpp']);
  }
  assert.equal(hook('pre_commit', { tool_input: { command: 'git commit -m check' } }), '');
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src/owned.cpp'), bad);
  run('git', ['add', '--', 'src/owned.cpp']);
  const mixed = JSON.parse(hook('pre_commit', { tool_input: { command: 'git commit -m check' } }));
  assert.equal(mixed.hookSpecificOutput.permissionDecision, 'deny');
  const reason = mixed.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /src\/owned.cpp/);
  assert.doesNotMatch(reason, /(?:3rd|thridpart|Third-Party|vendor)\/lib.cpp/);
  console.log('third_party.integration.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
