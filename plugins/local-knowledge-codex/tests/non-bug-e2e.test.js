'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnPythonSync } = require('./python-runtime');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'local_knowledge', 'cli.py');
const runner = path.join(root, 'scripts', 'run-hook.cjs');

function hook(input, environment) {
  /** Submit a user prompt through the real hook runner. */
  const result = spawnSync(process.execPath, [runner, 'user_prompt_submit'], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_ROOT: root, ...environment },
    windowsHide: process.platform === 'win32',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-knowledge-non-bug-e2e-'));
const environment = {
  LOCAL_KNOWLEDGE_HOME: temp,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
};

try {
  const remember = spawnPythonSync([cli, '--format', 'json', 'remember',
    '--kind', 'preference', '--canonical-key', 'reply.language',
    '--title', '\u56de\u590d\u8bed\u8a00\u504f\u597d',
    '--content', '\u9ed8\u8ba4\u4f7f\u7528\u4e2d\u6587\u56de\u7b54\uff0c\u6280\u672f\u8bf4\u660e\u4fdd\u6301\u7b80\u6d01\u3002',
    '--cues', '\u56de\u590d\u8bed\u8a00,\u4e2d\u6587\u56de\u7b54', '--recall-policy', 'on_match'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    windowsHide: process.platform === 'win32',
    timeout: 10000,
  });
  assert.equal(remember.status, 0, remember.stderr);
  const stored = JSON.parse(remember.stdout);
  assert.equal(stored.operation, 'created');
  assert.equal(stored.kind, 'preference');
  assert.equal(stored.source, 'local_knowledge');

  const relevant = hook({
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u8bf7\u53c2\u8003\u56de\u590d\u8bed\u8a00\u548c\u4e2d\u6587\u56de\u7b54\uff0c\u544a\u8bc9\u6211\u9ed8\u8ba4\u5e94\u8be5\u600e\u4e48\u5904\u7406\u3002',
  }, environment);
  assert.notEqual(relevant, '');
  const relevantPayload = JSON.parse(relevant);
  const relevantContext = relevantPayload.hookSpecificOutput.additionalContext;
  assert.equal(relevantPayload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(relevantContext, /LOCAL_KNOWLEDGE_RECALL/);
  assert.match(relevantContext, /kind=preference/);
  assert.match(relevantContext, /\u9ed8\u8ba4\u4f7f\u7528\u4e2d\u6587\u56de\u7b54/);
  assert.doesNotMatch(relevantContext, /BUGDB_/);

  const unrelated = hook({
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u91cf\u5b50\u7269\u7406\u4e2d\u7684\u8d39\u7c73\u5b50\u6709\u54ea\u4e9b\u6027\u8d28\uff1f',
  }, environment);
  assert.equal(unrelated, '');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('non-bug-e2e.test.js PASS');
