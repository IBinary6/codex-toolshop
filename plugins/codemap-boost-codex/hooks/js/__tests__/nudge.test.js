'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const runner = path.join(pluginRoot, 'scripts', 'run-hook.cjs');
const subagentSource = fs.readFileSync(path.join(pluginRoot, 'hooks', 'js', 'subagent_start.js'), 'utf8');
const { CONTEXT, promptLooksStructural } = require('../lib/codemap');

function initRepo(cwd) {
  const result = spawnSync('git', ['init', '--quiet'], {
    cwd, encoding: 'utf8', windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(result.status, 0, result.stderr);
}

assert.ok(!subagentSource.includes('refreshCrgSync'), 'SubagentStart must not launch a duplicate graph refresh');
for (const prompt of ['\u8bf7\u5206\u6790 auth \u6a21\u5757\u7684\u4f9d\u8d56\u5173\u7cfb', 'review these changes', 'What depends on auth?', 'Find all callers of Foo', '\u68b3\u7406\u5f53\u524d\u6a21\u5757\u67b6\u6784']) {
  assert.equal(promptLooksStructural(prompt), true, prompt);
}
for (const prompt of ['\u5199\u4e00\u4e2a\u51fd\u6570\u8fd4\u56de\u7248\u672c\u53f7', 'write a class to store a point', '\u89e3\u91ca\u8fd9\u4e2a\u82f1\u8bed\u5355\u8bcd', '\u4fee\u6539 README \u62fc\u5199']) {
  assert.equal(promptLooksStructural(prompt), false, prompt);
}

function runHook(name, payload, extraEnv = {}, availability = 'available') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-nudge-'));
  try {
    initRepo(tmp);
    const pluginData = path.join(tmp, 'data');
    fs.mkdirSync(pluginData, { recursive: true });
    fs.writeFileSync(path.join(pluginData, '.codemap-boost-enabled'), '1', 'utf8');
    const graphEnv = availability === 'disabled'
      ? { CODEMAP_BOOST_ASSUME_CRG: '1', CODEMAP_BOOST_DISABLE_GRAPH: '1' }
      : availability === 'missing' ? {} : { CODEMAP_BOOST_ASSUME_CRG: '1' };
    return spawnSync(process.execPath, [runner, name], {
      cwd: tmp,
      input: JSON.stringify(payload || {}),
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_HOME: path.join(tmp, 'codex-home'),
        PLUGIN_ROOT: pluginRoot,
        PLUGIN_DATA: pluginData,
        CODEMAP_BOOST_DISABLE_BOOTSTRAP: '1',
        ...graphEnv,
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
  const result = runHook('user_prompt_submit', { prompt: '\u5e2e\u6211\u67e5\u4e00\u4e0b Foo::Bar \u7684\u8c03\u7528\u5173\u7cfb' }, {}, 'disabled');
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, '', 'explicitly disabled CodeMap should not nudge even when CRG exists');
}

{
  const result = runHook('user_prompt_submit', { prompt: '\u5e2e\u6211\u67e5\u4e00\u4e0b Foo::Bar \u7684\u8c03\u7528\u5173\u7cfb' }, {}, 'missing');
  const payload = parseOutput(result);
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(payload.hookSpecificOutput.additionalContext, /unavailable only for now/,
    'a currently missing runtime still yields fallback and rediscovery guidance');
}

{
  const result = runHook('user_prompt_submit', { prompt: '\u5e2e\u6211\u67e5\u4e00\u4e0b Foo::Bar \u7684\u8c03\u7528\u5173\u7cfb' });
  const payload = parseOutput(result);
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('code-review-graph'), 'prompt nudge mentions CRG');
  assert.ok(!payload.hookSpecificOutput.additionalContext.includes('refresh completed'), 'prompt keywords must not claim a completed build');
}

{
  const result = runHook('user_prompt_submit', { prompt: '\u5199\u4e00\u53e5\u63d0\u4ea4\u8bf4\u660e' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, '', 'non-structural prompt should be silent');
}

{
  const result = runHook('subagent_start', { subagent_type: 'explorer' });
  const payload = parseOutput(result);
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.strictEqual(payload.hookSpecificOutput.additionalContext, CONTEXT,
    'SubagentStart injects the same three-point text as the managed AGENTS block');
  assert.ok(CONTEXT.includes('Hooks own refresh and the pre-read barrier'), 'shared second point preserves hook refresh ownership');
  assert.ok(CONTEXT.includes('current tool catalog and deferred discovery'), 'shared guidance preserves deferred-tool discovery');
  assert.ok(CONTEXT.includes('Combine only as needed'), 'shared guidance avoids redundant tool rounds');
  assert.ok(CONTEXT.includes('A text match does not prove a relationship, and zero matches do not prove absence'), 'shared third point preserves evidence limits');
  assert.ok(!payload.hookSpecificOutput.additionalContext.includes('refresh completed'));
}

console.log('nudge.test.js PASS');

// Use consecutive real entry-point calls to verify deduplication and reset; write state only to isolated temporary plugin data.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-phase-'));
  try {
    initRepo(tmp);
    const env = { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: tmp,
      CODEX_HOME: tmp, CODEMAP_BOOST_DISABLE_BOOTSTRAP: '1', CODEMAP_BOOST_ASSUME_CRG: '1' };
    delete env.CODEMAP_BOOST_DISABLE_GRAPH;
    fs.writeFileSync(path.join(tmp, '.codemap-boost-enabled'), '1');
    const base = { session_id: 's', turn_id: 't', cwd: tmp };
    const invoke = (name, extra) => {
      const result = spawnSync(process.execPath, [runner, name], {
        cwd: tmp, env, input: JSON.stringify({ ...base, ...extra }), encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
    };
    const search = { tool_name: 'Bash', tool_input: { command: 'rg Auth src' } };
    assert.equal(invoke('pre_code_search', { tool_name: 'Bash', tool_input: { command: 'rg --files' } }), null);
    const first = invoke('pre_code_search', search);
    assert.equal(first.hookEventName, 'PreToolUse');
    assert.match(first.additionalContext, /query available graph tools first/);
    assert.equal(first.permissionDecision, undefined, 'reminder cannot deny or rewrite commands');
    assert.equal(invoke('pre_code_search', search), null);
    invoke('user_prompt_submit', { prompt: '\u7ee7\u7eed\u6838\u5bf9\u8c03\u7528\u5173\u7cfb' });
    assert.ok(invoke('pre_code_search', search), 'new message with unchanged turn_id restores reminder');
    assert.equal(invoke('pre_code_search', search), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
