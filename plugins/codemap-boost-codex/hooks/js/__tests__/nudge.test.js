'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const runner = path.join(pluginRoot, 'scripts', 'run-hook.cjs');

function runHook(name, payload, extraEnv = {}, enabled = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-nudge-'));
  try {
    const enableEnv = enabled ? { CODEMAP_BOOST_ENABLE_GRAPH: '1' } : {};
    return spawnSync(process.execPath, [runner, name], {
      cwd: tmp,
      input: JSON.stringify(payload || {}),
      encoding: 'utf8',
      env: {
        ...process.env,
        PLUGIN_ROOT: pluginRoot,
        PLUGIN_DATA: path.join(tmp, 'data'),
        CODEMAP_BOOST_ASSUME_CRG: '1',
        CODEMAP_BOOST_DISABLE_BOOTSTRAP: '1',
        ...enableEnv,
        ...extraEnv,
      },
      windowsHide: process.platform === 'win32',
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function parseOutput(result) {
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stderr, '', 'hook stderr should be silent');
  return JSON.parse(result.stdout);
}

{
  const result = runHook('user_prompt_submit', { prompt: '帮我查一下 Foo::Bar 的调用关系' }, {}, false);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, '', 'inactive CodeMap should not nudge even when CRG exists');
}

{
  const result = runHook('user_prompt_submit', { prompt: '帮我查一下 Foo::Bar 的调用关系' });
  const payload = parseOutput(result);
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('code-review-graph'), 'prompt nudge mentions CRG');
}

{
  const result = runHook('user_prompt_submit', { prompt: '写一句提交说明' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, '', 'non-structural prompt should be silent');
}

{
  const result = runHook('pre_bash', { tool_input: { command: 'rg "class Foo" src' } });
  const payload = parseOutput(result);
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(!payload.hookSpecificOutput.permissionDecision, 'Bash nudge must not deny');
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('get_minimal_context_tool'));
}

{
  const result = runHook('pre_bash', { tool_input: { command: 'git status --short' } });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, '', 'non-search Bash command should be silent');
}

{
  const result = runHook('subagent_start', { subagent_type: 'explorer' });
  const payload = parseOutput(result);
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('semantic_search_nodes_tool'));
}

console.log('nudge.test.js PASS');
