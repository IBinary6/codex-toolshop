'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const runner = path.join(root, 'scripts', 'run-hook.cjs');
const python = process.env.BUGDB_TEST_PYTHON || 'python';

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
assert.match(JSON.parse(missingPython).hookSpecificOutput.additionalContext, /BUGDB_SETUP_HINT/);

const lookup = run('user_prompt_submit', {
  hook_event_name: 'UserPromptSubmit',
  prompt: '请先看看 error LNK2001 unresolved external symbol。',
});
assert.match(JSON.parse(lookup).hookSpecificOutput.additionalContext, /BUGDB_LOOKUP_HINT/);

const record = run('user_prompt_submit', {
  hook_event_name: 'UserPromptSubmit',
  prompt: '这个构建已经跑通了，方案已确认有效。',
});
assert.match(JSON.parse(record).hookSpecificOutput.additionalContext, /BUGDB_RECORD_HINT/);

assert.equal(run('user_prompt_submit', {
  hook_event_name: 'UserPromptSubmit',
  prompt: '请解释这段代码的作用。',
}), '');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bugdb-codex-hook-'));
try {
  const add = spawnSync(python, [path.join(root, 'bugdb', 'cli.py'), 'add',
    '--category', 'link', '--context', 'error LNK2019 unresolved external symbol Foo',
    '--cause', 'missing library', '--content', 'link the required library',
    '--language', 'c++', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, BUGDB_HOME: temp },
    windowsHide: process.platform === 'win32',
  });
  assert.equal(add.status, 0, add.stderr);
  const id = JSON.parse(add.stdout).id;
  const output = run('post_tool_use', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_output: 'main.cpp(4): error LNK2019: unresolved external symbol Foo',
  }, {
    BUGDB_HOME: temp,
    BUGDB_PYTHON: python,
  });
  const payload = JSON.parse(output);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(payload.hookSpecificOutput.additionalContext, new RegExp(`id=${id}`));

  const structuredOutput = run('post_tool_use', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: {
      content: [
        { type: 'text', text: 'main.cpp(4): error LNK2019: unresolved external symbol Foo' },
      ],
    },
  }, {
    BUGDB_HOME: temp,
    BUGDB_PYTHON: python,
  });
  assert.match(JSON.parse(structuredOutput).hookSpecificOutput.additionalContext,
    new RegExp(`id=${id}`));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('hooks.test.js PASS');
