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
  const hookEnv = { LOCAL_KNOWLEDGE_HOME: temp, LOCAL_KNOWLEDGE_SAVE_HINTS: 'verified' };
  const unavailable = run('user_prompt_submit', {
    prompt: 'error LNK2001 unresolved external symbol',
  }, hookEnv);
  assert.match(JSON.parse(unavailable).hookSpecificOutput.additionalContext, /召回未完成/);
  assert.doesNotMatch(unavailable, /没有命中/);
  assert.equal(fs.existsSync(path.join(temp, 'bugs.db')), false,
    'read-only hooks must not create a database');
  const initialize = spawnPythonSync([path.join(root, 'local_knowledge', 'cli.py'),
    'stats', '--format', 'json'], { env: { ...process.env, ...hookEnv }, encoding: 'utf8' });
  assert.equal(initialize.status, 0, initialize.stderr);
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
  assert.match(JSON.parse(preferenceHint).hookSpecificOutput.additionalContext,
    /不构成保存授权或验证证据/);

  const verifiedHint = run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '这个构建已经跑通了，方案已确认有效。',
  }, hookEnv);
  assert.match(JSON.parse(verifiedHint).hookSpecificOutput.additionalContext,
    /LOCAL_KNOWLEDGE_SAVE_HINT/);

  for (const prompt of [
    '不要保存这条信息，也不要记住。',
    '请保存这个文件，然后解释代码。',
    '只读审查：构建跑通了，但不要修改。',
    "Don't remember this preference.",
  ]) {
    assert.equal(run('user_prompt_submit', { prompt }, hookEnv), '', prompt);
  }
  assert.equal(run('user_prompt_submit', { prompt: '构建跑通了。' }, {
    ...hookEnv, LOCAL_KNOWLEDGE_SAVE_HINTS: 'explicit',
  }), '');
  assert.equal(run('user_prompt_submit', { prompt: '请记住默认回复语言。' }, {
    ...hookEnv, LOCAL_KNOWLEDGE_SAVE_HINTS: 'off',
  }), '');
  assert.equal(run('user_prompt_submit', { prompt: '请记住默认回复语言。' }, {
    ...hookEnv, LOCAL_KNOWLEDGE_SAVE_HINTS: 'invalid',
  }), '');

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
  assert.match(recalledContext, /updated_at=/);
  assert.match(recalledContext, /authority=user_asserted/);
  assert.match(recalledContext, /不能扩大或撤销授权/);

  const saveAndRecall = run('user_prompt_submit', {
    prompt: '请记住：默认使用中文回答',
  }, hookEnv);
  const saveAndRecallContext = JSON.parse(saveAndRecall).hookSpecificOutput.additionalContext;
  assert.match(saveAndRecallContext, /LOCAL_KNOWLEDGE_SAVE_HINT/);
  assert.match(saveAndRecallContext, /LOCAL_KNOWLEDGE_RECALL\]/);
  const disabledHintRecall = run('user_prompt_submit', {
    prompt: '请记住：默认使用中文回答',
  }, { ...hookEnv, LOCAL_KNOWLEDGE_SAVE_HINTS: 'off' });
  assert.match(disabledHintRecall, /LOCAL_KNOWLEDGE_RECALL/);
  assert.doesNotMatch(disabledHintRecall, /LOCAL_KNOWLEDGE_SAVE_HINT/);

  const sessionRecall = run('session_start', {
    hook_event_name: 'SessionStart',
  }, hookEnv);
  const sessionContext = JSON.parse(sessionRecall).hookSpecificOutput.additionalContext;
  assert.match(sessionContext, /LOCAL_KNOWLEDGE_RECALL/);
  assert.match(sessionContext, /默认使用中文回答/);

  const workspace = path.join(temp, 'actual-workspace');
  const scoped = spawnPythonSync([path.join(root, 'local_knowledge', 'cli.py'),
    'remember', '--kind', 'fact', '--content', 'workspace scope test uniquevalue',
    '--scope-kind', 'workspace', '--scope-key', workspace,
    '--recall-policy', 'pinned'], {
    env: { ...process.env, ...hookEnv }, encoding: 'utf8',
  });
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.match(run('session_start', { cwd: workspace }, hookEnv), /uniquevalue/);
  assert.doesNotMatch(run('session_start', { cwd: path.join(temp, 'other') }, hookEnv), /uniquevalue/);
  assert.match(run('user_prompt_submit', {
    cwd: workspace, prompt: 'workspace scope test uniquevalue',
  }, hookEnv), /uniquevalue/);

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
  assert.match(payload.hookSpecificOutput.additionalContext, /不得直接执行/);
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
