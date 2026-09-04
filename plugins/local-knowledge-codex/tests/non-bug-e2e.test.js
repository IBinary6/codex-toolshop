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
  /** 通过真实 hook runner 提交一条用户提示。 */
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
    '--title', '回复语言偏好',
    '--content', '默认使用中文回答，技术说明保持简洁。',
    '--cues', '回复语言,中文回答', '--recall-policy', 'on_match'], {
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
    prompt: '请参考回复语言和中文回答，告诉我默认应该怎么处理。',
  }, environment);
  assert.notEqual(relevant, '');
  const relevantPayload = JSON.parse(relevant);
  const relevantContext = relevantPayload.hookSpecificOutput.additionalContext;
  assert.equal(relevantPayload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(relevantContext, /LOCAL_KNOWLEDGE_RECALL/);
  assert.match(relevantContext, /kind=preference/);
  assert.match(relevantContext, /默认使用中文回答/);
  assert.doesNotMatch(relevantContext, /BUGDB_/);

  const unrelated = hook({
    hook_event_name: 'UserPromptSubmit',
    prompt: '量子物理中的费米子有哪些性质？',
  }, environment);
  assert.equal(unrelated, '');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('non-bug-e2e.test.js PASS');
