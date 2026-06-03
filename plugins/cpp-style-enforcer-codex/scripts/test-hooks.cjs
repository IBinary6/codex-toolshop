'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = path.resolve(__dirname, '..');
const runner = path.join(pluginRoot, 'scripts', 'run-hook.cjs');

function sh(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: process.platform === 'win32',
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runHook(name, payload, cwd, dataDir) {
  return spawnSync(process.execPath, [runner, name], {
    cwd,
    input: payload ? JSON.stringify(payload) : '',
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_DATA: dataDir,
    },
    windowsHide: process.platform === 'win32',
  });
}

function requirePython() {
  for (const py of ['python', 'python3']) {
    const result = sh(py, ['--version']);
    if (result.status === 0) return;
  }
  throw new Error('python or python3 is required for cpplint hook tests');
}

function initRepo(repo) {
  const result = sh('git', ['init'], { cwd: repo });
  assert.strictEqual(result.status, 0, result.stderr);
}

function main() {
  requirePython();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-style-enforcer-codex-'));
  const dataDir = path.join(tmp, 'data');

  const textFile = path.join(tmp, 'note.txt');
  fs.writeFileSync(textFile, 'hello\n', 'utf8');
  const nonCpp = runHook('post_edit', { tool_input: { file_path: textFile } }, tmp, dataDir);
  assert.strictEqual(nonCpp.status, 0, nonCpp.stderr);
  assert.strictEqual(nonCpp.stdout, '', 'non-C++ edit should be silent');

  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  writeJson(path.join(repo, '.claude-cpp-style', 'cpp-style.json'), {
    enabled: true,
    mode: 'full',
    checks: { clangFormat: false, copyright: false, cpplint: true, bom: false },
  });

  const badCpp = path.join(repo, 'bad.cpp');
  fs.writeFileSync(badCpp, 'int main() { int x = (int)3; return x; }\n', 'utf8');

  const post = runHook('post_edit', { tool_input: { file_path: badCpp } }, repo, dataDir);
  assert.strictEqual(post.status, 0, post.stderr);
  const postPayload = JSON.parse(post.stdout);
  assert.strictEqual(postPayload.decision, 'block');
  assert.match(postPayload.reason, /cpplint|C\+\+|违规/);

  sh('git', ['add', 'bad.cpp'], { cwd: repo });
  const pre = runHook('pre_commit', { tool_input: { command: 'git commit -m test' } }, repo, dataDir);
  assert.strictEqual(pre.status, 0, pre.stderr);
  const prePayload = JSON.parse(pre.stdout);
  assert.strictEqual(prePayload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(prePayload.hookSpecificOutput.permissionDecisionReason, /提交被阻止|cpplint/);

  console.log('test-hooks PASS');
}

main();
