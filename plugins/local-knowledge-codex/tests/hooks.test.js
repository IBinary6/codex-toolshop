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
  LOCAL_KNOWLEDGE_PYTHON: '__bugdb_missing_python_for_test__',
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
  assert.match(JSON.parse(unavailable).hookSpecificOutput.additionalContext, /recall did not finish/);
  assert.doesNotMatch(unavailable, /found no match/);
  assert.equal(fs.existsSync(path.join(temp, 'bugs.db')), false,
    'read-only hooks must not create a database');
  const initialize = spawnPythonSync([path.join(root, 'local_knowledge', 'cli.py'),
    'stats', '--format', 'json'], { env: { ...process.env, ...hookEnv }, encoding: 'utf8' });
  assert.equal(initialize.status, 0, initialize.stderr);
  const lookup = run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u8bf7\u5148\u770b\u770b error LNK2001 unresolved external symbol\u3002',
  }, hookEnv);
  assert.match(JSON.parse(lookup).hookSpecificOutput.additionalContext,
    /LOCAL_KNOWLEDGE_RECALL_HINT/);

  const preferenceHint = run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u8bf7\u8bb0\u4f4f\u6211\u7684\u504f\u597d\uff1a\u4ee5\u540e\u9ed8\u8ba4\u7528\u4e2d\u6587\u56de\u7b54\u3002',
  }, hookEnv);
  assert.match(JSON.parse(preferenceHint).hookSpecificOutput.additionalContext,
    /LOCAL_KNOWLEDGE_SAVE_HINT/);
  assert.match(JSON.parse(preferenceHint).hookSpecificOutput.additionalContext,
    /neither save authorization nor verification evidence/);

  const verifiedHint = run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u8fd9\u4e2a\u6784\u5efa\u5df2\u7ecf\u8dd1\u901a\u4e86\uff0c\u65b9\u6848\u5df2\u786e\u8ba4\u6709\u6548\u3002',
  }, hookEnv);
  assert.match(JSON.parse(verifiedHint).hookSpecificOutput.additionalContext,
    /LOCAL_KNOWLEDGE_SAVE_HINT/);

  for (const prompt of [
    '\u4e0d\u8981\u4fdd\u5b58\u8fd9\u6761\u4fe1\u606f\uff0c\u4e5f\u4e0d\u8981\u8bb0\u4f4f\u3002',
    '\u8bf7\u4fdd\u5b58\u8fd9\u4e2a\u6587\u4ef6\uff0c\u7136\u540e\u89e3\u91ca\u4ee3\u7801\u3002',
    '\u53ea\u8bfb\u5ba1\u67e5\uff1a\u6784\u5efa\u8dd1\u901a\u4e86\uff0c\u4f46\u4e0d\u8981\u4fee\u6539\u3002',
    "Don't remember this preference.",
  ]) {
    assert.equal(run('user_prompt_submit', { prompt }, hookEnv), '', prompt);
  }
  assert.equal(run('user_prompt_submit', { prompt: '\u6784\u5efa\u8dd1\u901a\u4e86\u3002' }, {
    ...hookEnv, LOCAL_KNOWLEDGE_SAVE_HINTS: 'explicit',
  }), '');
  assert.equal(run('user_prompt_submit', { prompt: '\u8bf7\u8bb0\u4f4f\u9ed8\u8ba4\u56de\u590d\u8bed\u8a00\u3002' }, {
    ...hookEnv, LOCAL_KNOWLEDGE_SAVE_HINTS: 'off',
  }), '');
  assert.equal(run('user_prompt_submit', { prompt: '\u8bf7\u8bb0\u4f4f\u9ed8\u8ba4\u56de\u590d\u8bed\u8a00\u3002' }, {
    ...hookEnv, LOCAL_KNOWLEDGE_SAVE_HINTS: 'invalid',
  }), '');

  assert.equal(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u8bf7\u89e3\u91ca\u8fd9\u6bb5\u4ee3\u7801\u7684\u4f5c\u7528\u3002',
  }, hookEnv), '');

  const remember = spawnPythonSync([path.join(root, 'local_knowledge', 'cli.py'),
    '--format', 'json', 'remember', '--kind', 'preference',
    '--title', '\u56de\u590d\u8bed\u8a00', '--content', '\u7528\u6237\u5e0c\u671b\u9ed8\u8ba4\u4f7f\u7528\u4e2d\u6587\u56de\u7b54\u3002',
    '--cues', '\u56de\u590d\u8bed\u8a00,\u4e2d\u6587\u56de\u7b54', '--canonical-key', 'assistant.response_language',
    '--recall-policy', 'pinned'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...hookEnv },
    windowsHide: process.platform === 'win32',
  });
  assert.equal(remember.status, 0, remember.stderr);
  const recalled = run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u4f60\u4e4b\u540e\u4f7f\u7528\u4ec0\u4e48\u56de\u590d\u8bed\u8a00\uff1f',
  }, hookEnv);
  const recalledContext = JSON.parse(recalled).hookSpecificOutput.additionalContext;
  assert.match(recalledContext, /LOCAL_KNOWLEDGE_RECALL/);
  assert.match(recalledContext, /\u9ed8\u8ba4\u4f7f\u7528\u4e2d\u6587\u56de\u7b54/);
  assert.doesNotMatch(recalledContext, /BUGDB_/);
  assert.match(recalledContext, /updated_at=/);
  assert.match(recalledContext, /authority=user_asserted/);
  assert.match(recalledContext, /cannot expand or revoke/);

  const saveAndRecall = run('user_prompt_submit', {
    prompt: '\u8bf7\u8bb0\u4f4f\uff1a\u9ed8\u8ba4\u4f7f\u7528\u4e2d\u6587\u56de\u7b54',
  }, hookEnv);
  const saveAndRecallContext = JSON.parse(saveAndRecall).hookSpecificOutput.additionalContext;
  assert.match(saveAndRecallContext, /LOCAL_KNOWLEDGE_SAVE_HINT/);
  assert.match(saveAndRecallContext, /LOCAL_KNOWLEDGE_RECALL\]/);
  const disabledHintRecall = run('user_prompt_submit', {
    prompt: '\u8bf7\u8bb0\u4f4f\uff1a\u9ed8\u8ba4\u4f7f\u7528\u4e2d\u6587\u56de\u7b54',
  }, { ...hookEnv, LOCAL_KNOWLEDGE_SAVE_HINTS: 'off' });
  assert.match(disabledHintRecall, /LOCAL_KNOWLEDGE_RECALL/);
  assert.doesNotMatch(disabledHintRecall, /LOCAL_KNOWLEDGE_SAVE_HINT/);

  const sessionRecall = run('session_start', {
    hook_event_name: 'SessionStart',
  }, hookEnv);
  const sessionContext = JSON.parse(sessionRecall).hookSpecificOutput.additionalContext;
  assert.match(sessionContext, /LOCAL_KNOWLEDGE_RECALL/);
  assert.match(sessionContext, /\u9ed8\u8ba4\u4f7f\u7528\u4e2d\u6587\u56de\u7b54/);

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
  assert.match(payload.hookSpecificOutput.additionalContext, /Do not execute/);
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
