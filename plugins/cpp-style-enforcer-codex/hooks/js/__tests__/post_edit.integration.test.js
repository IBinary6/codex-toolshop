const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const entry = path.join(pluginRoot, 'hooks', 'js', 'post_edit.js');
const stopEntry = path.join(pluginRoot, 'hooks', 'js', 'stop_check.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-pe-data-'));
let hookCounter = 0;

function runHook(input) {
  hookCounter += 1;
  const payload = {
    session_id: 'post-edit-test',
    turn_id: `turn-${hookCounter}`,
    tool_use_id: `tool-${hookCounter}`,
    ...input,
  };
  const r = spawnSync('node', [entry], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, PLUGIN_DATA: dataDir },
  });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '', payload };
}

function runStop(payload) {
  const r = spawnSync('node', [stopEntry], {
    cwd: payload.cwd || process.cwd(),
    input: JSON.stringify({
      session_id: payload.session_id,
      turn_id: payload.turn_id,
      cwd: payload.cwd || process.cwd(),
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }),
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, PLUGIN_DATA: dataDir },
  });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' };
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cse-pe-'));
}

// 1) Bash input mentioning .cpp without file_path passes silently (exit 0, empty stdout).
{
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'echo build main.cpp' } });
  assert.strictEqual(r.status, 0, 'Bash without file_path exits 0');
  assert.strictEqual(r.stdout, '', 'Bash leaves stdout empty');
}

// 2) Missing file: passSilent.
{
  const r = runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(mkTmpDir(), 'nope.cpp') } });
  assert.strictEqual(r.status, 0, 'Missing file exits 0');
  assert.strictEqual(r.stdout, '', 'Missing file leaves stdout empty');
}

// 3) Non-C++ file: passSilent.
{
  const dir = mkTmpDir();
  const f = path.join(dir, 'readme.txt');
  fs.writeFileSync(f, 'hello');
  const r = runHook({ tool_name: 'Edit', tool_input: { file_path: f } });
  assert.strictEqual(r.status, 0, 'Non-C++ file exits 0');
  assert.strictEqual(r.stdout, '', 'Non-C++ file leaves stdout empty');
}

// 4) Disabled project: no-op even with a violation.
{
  const dir = mkTmpDir();
  fs.mkdirSync(path.join(dir, '.claude-cpp-style'));
  fs.writeFileSync(path.join(dir, '.claude-cpp-style', 'cpp-style.json'), JSON.stringify({ enabled: false }));
  const f = path.join(dir, 'main.cpp');
  fs.writeFileSync(f, 'int main(){return 0;}\n');
  const before = fs.readFileSync(f);
  const r = runHook({ tool_name: 'Edit', tool_input: { file_path: f } });
  assert.strictEqual(r.status, 0, 'Disabled hook exits 0');
  assert.strictEqual(r.stdout, '', 'Disabled hook leaves stdout empty');
  assert.ok(fs.readFileSync(f).equals(before), 'Disabled hook leaves the file unchanged, including its BOM');
}

// 5) Protocol invariant: never exit 2 or 1.
{
  const r = runHook({ tool_name: 'Edit', tool_input: {} });
  assert.notStrictEqual(r.status, 2, 'Never exits 2');
  assert.notStrictEqual(r.status, 1, 'Never exits 1');
}

// 6) A Codex apply_patch command may touch multiple files; CMake projects still add UTF-8 BOM.
{
  const dir = mkTmpDir();
  const file = path.join(dir, 'failed.cpp');
  fs.writeFileSync(file, 'int  value;\n');
  const before = fs.readFileSync(file);
  const failed = runHook({ cwd: dir, tool_name: 'Edit',
    tool_input: { file_path: file }, tool_response: { isError: true } });
  assert.strictEqual(failed.status, 0);
  assert.strictEqual(runStop(failed.payload).stdout, '{}', 'Failed edits are not queued for later automatic fixes');
  assert.ok(fs.readFileSync(file).equals(before));
}

{
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'CMakeLists.txt'), 'project(test)\n');
  fs.mkdirSync(path.join(dir, '.codex-cpp-style'));
  fs.writeFileSync(path.join(dir, '.codex-cpp-style', 'cpp-style.json'), JSON.stringify({
    checks: { clangFormat: false, copyright: false, cpplint: false, bom: true },
  }));
  const a = path.join(dir, 'a.cpp');
  const b = path.join(dir, 'b.hpp');
  fs.writeFileSync(a, 'int a;\n');
  fs.writeFileSync(b, '#pragma once\n');
  const r = runHook({
    cwd: dir,
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Update File: a.cpp',
        '*** Update File: b.hpp',
        '*** End Patch',
      ].join('\n'),
    },
  });
  assert.strictEqual(r.status, 0, 'apply_patch post-processing exits 0');
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  assert.ok(!fs.readFileSync(a).subarray(0, 3).equals(bom), 'PostToolUse does not add a BOM immediately');
  const stop = runStop(r.payload);
  assert.strictEqual(stop.status, 0, 'Stop processing exits 0');
  assert.ok(fs.readFileSync(a).subarray(0, 3).equals(bom), 'CMake a.cpp receives a BOM');
  assert.ok(fs.readFileSync(b).subarray(0, 3).equals(bom), 'Second apply_patch file b.hpp receives a BOM');
}

console.log('post_edit.integration.test.js PASS');
