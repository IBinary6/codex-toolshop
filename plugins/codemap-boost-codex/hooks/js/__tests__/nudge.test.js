'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const runner = path.join(pluginRoot, 'scripts', 'run-hook.cjs');
const subagentSource = fs.readFileSync(path.join(pluginRoot, 'hooks', 'js', 'subagent_start.js'), 'utf8');
const { promptLooksStructural } = require('../lib/codemap');

function initRepo(cwd) {
  const result = spawnSync('git', ['init', '--quiet'], {
    cwd, encoding: 'utf8', windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(result.status, 0, result.stderr);
}

assert.ok(!subagentSource.includes('refreshCrgSync'), 'SubagentStart must not launch a duplicate graph refresh');
for (const prompt of ['请分析 auth 模块的依赖关系', 'review these changes', 'What depends on auth?', 'Find all callers of Foo', '梳理当前模块架构']) {
  assert.equal(promptLooksStructural(prompt), true, prompt);
}
for (const prompt of ['写一个函数返回版本号', 'write a class to store a point', '解释这个英语单词', '修改 README 拼写']) {
  assert.equal(promptLooksStructural(prompt), false, prompt);
}

function runHook(name, payload, extraEnv = {}, enabled = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-nudge-'));
  try {
    initRepo(tmp);
    const pluginData = path.join(tmp, 'data');
    fs.mkdirSync(pluginData, { recursive: true });
    fs.writeFileSync(path.join(pluginData, '.codemap-boost-enabled'), '1', 'utf8');
    const graphEnv = enabled
      ? { CODEMAP_BOOST_ASSUME_CRG: '1' }
      : { CODEMAP_BOOST_ASSUME_CRG: '1', CODEMAP_BOOST_DISABLE_GRAPH: '1' };
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
  const result = runHook('user_prompt_submit', { prompt: '帮我查一下 Foo::Bar 的调用关系' }, {}, false);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, '', 'explicitly disabled CodeMap should not nudge even when CRG exists');
}

{
  const result = runHook('user_prompt_submit', { prompt: '帮我查一下 Foo::Bar 的调用关系' });
  const payload = parseOutput(result);
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('code-review-graph'), 'prompt nudge mentions CRG');
  assert.ok(!payload.hookSpecificOutput.additionalContext.includes('refresh completed'), 'prompt keywords must not claim a completed build');
}

{
  const result = runHook('user_prompt_submit', { prompt: '写一句提交说明' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, '', 'non-structural prompt should be silent');
}

{
  const result = runHook('subagent_start', { subagent_type: 'explorer' });
  const payload = parseOutput(result);
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('semantic_search_nodes_tool'));
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('do not repeat minimal'));
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('SubagentStart injects these rules without refreshing again'));
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('Do not start a duplicate build/update'));
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('If the current tool list does not expose mcp__code_review_graph__'));
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('report that the MCP tools are unavailable'));
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('deferred'));
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('ALL_TOOLS'));
  assert.ok(payload.hookSpecificOutput.additionalContext.includes('top-level tool list alone does not prove'));
  assert.ok(!payload.hookSpecificOutput.additionalContext.includes('refresh completed'));
}

console.log('nudge.test.js PASS');

// 连续真实入口调用验证去重与复位；所有状态只写隔离的临时插件数据目录。
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
    assert.match(first.additionalContext, /先查询可用的图工具/);
    assert.equal(first.permissionDecision, undefined, 'reminder cannot deny or rewrite commands');
    assert.equal(invoke('pre_code_search', search), null);
    invoke('user_prompt_submit', { prompt: '继续核对调用关系' });
    assert.ok(invoke('pre_code_search', search), 'new message with unchanged turn_id restores reminder');
    assert.equal(invoke('pre_code_search', search), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
