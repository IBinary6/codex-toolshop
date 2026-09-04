'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnPythonSync } = require('./python-runtime');

const root = path.resolve(__dirname, '..');
const runner = path.join(root, 'scripts', 'run-hook.cjs');
const { HOOK_TIMEOUT_MS } = require(runner);
const { PYTHON_DETECTION_TIMEOUT_MS } = require('../scripts/python-launcher.cjs');
const { CLI_TIMEOUT_MS } = require('../hooks/js/local_knowledge_cli');

const hookManifest = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
const hostTimeoutMs = {
  session_start: hookManifest.hooks.SessionStart[0].hooks[0].timeout * 1000,
  post_tool_use: hookManifest.hooks.PostToolUse[0].hooks[0].timeout * 1000,
  user_prompt_submit: hookManifest.hooks.UserPromptSubmit[0].hooks[0].timeout * 1000,
};
for (const [hook, timeout] of Object.entries(HOOK_TIMEOUT_MS)) {
  assert.ok(timeout < hostTimeoutMs[hook], `${hook} runner must finish before host timeout`);
}
assert.ok(CLI_TIMEOUT_MS < HOOK_TIMEOUT_MS.post_tool_use);
assert.ok(CLI_TIMEOUT_MS < HOOK_TIMEOUT_MS.user_prompt_submit);
assert.ok(PYTHON_DETECTION_TIMEOUT_MS + CLI_TIMEOUT_MS < HOOK_TIMEOUT_MS.session_start);

function run(hook, input, extra = {}) {
  const result = spawnSync(process.execPath, [runner, hook], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_ROOT: root, ...extra },
    windowsHide: process.platform === 'win32',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const missingPython = run('session_start', { hook_event_name: 'SessionStart' }, {
  BUGDB_PYTHON: '__bugdb_missing_python_for_test__',
});
assert.match(JSON.parse(missingPython).hookSpecificOutput.additionalContext,
  /LOCAL_KNOWLEDGE_SETUP_HINT/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bugdb-codex-hook-'));
try {
  const hookEnv = { LOCAL_KNOWLEDGE_HOME: temp };
  const lookup = run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请先看看 error LNK2001 unresolved external symbol。',
  }, hookEnv);
  assert.match(JSON.parse(lookup).hookSpecificOutput.additionalContext,
    /LOCAL_KNOWLEDGE_RECALL_HINT/);

  const preferenceHint = run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请记住我的偏好：以后默认用中文回答。',
  }, hookEnv);
  assert.match(JSON.parse(preferenceHint).hookSpecificOutput.additionalContext,
    /LOCAL_KNOWLEDGE_SAVE_HINT/);

  const verifiedHint = run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '这个构建已经跑通了，方案已确认有效。',
  }, hookEnv);
  assert.match(JSON.parse(verifiedHint).hookSpecificOutput.additionalContext,
    /LOCAL_KNOWLEDGE_SAVE_HINT/);

  assert.equal(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请解释这段代码的作用。',
  }, hookEnv), '');

  const remember = spawnPythonSync([path.join(root, 'local_knowledge', 'cli.py'),
    '--format', 'json', 'remember', '--kind', 'preference',
    '--title', '回复语言', '--content', '用户希望默认使用中文回答。',
    '--cues', '回复语言,中文回答', '--canonical-key', 'assistant.response_language',
    '--recall-policy', 'pinned'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...hookEnv },
    windowsHide: process.platform === 'win32',
  });
  assert.equal(remember.status, 0, remember.stderr);
  const recalled = run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '你之后使用什么回复语言？',
  }, hookEnv);
  const recalledContext = JSON.parse(recalled).hookSpecificOutput.additionalContext;
  assert.match(recalledContext, /LOCAL_KNOWLEDGE_RECALL/);
  assert.match(recalledContext, /默认使用中文回答/);
  assert.doesNotMatch(recalledContext, /BUGDB_/);

  const sessionRecall = run('session_start', {
    hook_event_name: 'SessionStart',
  }, hookEnv);
  const sessionContext = JSON.parse(sessionRecall).hookSpecificOutput.additionalContext;
  assert.match(sessionContext, /LOCAL_KNOWLEDGE_RECALL/);
  assert.match(sessionContext, /默认使用中文回答/);

  const add = spawnPythonSync([path.join(root, 'bugdb', 'cli.py'), 'add',
    '--category', 'link', '--context', 'error LNK2019 unresolved external symbol Foo',
    '--cause', 'missing library', '--content', 'link the required library',
    '--language', 'c++', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, LOCAL_KNOWLEDGE_HOME: temp },
    windowsHide: process.platform === 'win32',
  });
  assert.equal(add.status, 0, add.stderr);
  const id = JSON.parse(add.stdout).id;
  const output = run('post_tool_use', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    exit_code: 1,
    tool_output: 'main.cpp(4): error LNK2019: unresolved external symbol Foo',
  }, hookEnv);
  const payload = JSON.parse(output);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(payload.hookSpecificOutput.additionalContext, new RegExp(`id=${id}`));
  assert.match(payload.hookSpecificOutput.additionalContext, /LOCAL_KNOWLEDGE_MATCH/);
  assert.doesNotMatch(payload.hookSpecificOutput.additionalContext, /BUGDB_/);

  const successfulSearchOutput = run('post_tool_use', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    exit_code: 0,
    tool_output: 'README contains example error LNK2019 unresolved external symbol Foo',
  }, hookEnv);
  assert.equal(successfulSearchOutput, '');

  const readOnlySearchOutput = run('post_tool_use', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: "sed -n '1,80p' README.md" },
    tool_output: 'README contains example error LNK2019 unresolved external symbol Foo',
  }, hookEnv);
  assert.equal(readOnlySearchOutput, '');

  const unknownStatusErrorOutput = run('post_tool_use', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo "error LNK2019 unresolved external symbol Foo"' },
    tool_output: 'error LNK2019 unresolved external symbol Foo',
  }, hookEnv);
  assert.equal(unknownStatusErrorOutput, '');

  const structuredOutput = run('post_tool_use', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: {
      exit_code: 1,
      content: [
        { type: 'text', text: 'main.cpp(4): error LNK2019: unresolved external symbol Foo' },
      ],
    },
  }, hookEnv);
  assert.match(JSON.parse(structuredOutput).hookSpecificOutput.additionalContext,
    new RegExp(`id=${id}`));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('hooks.test.js PASS');
