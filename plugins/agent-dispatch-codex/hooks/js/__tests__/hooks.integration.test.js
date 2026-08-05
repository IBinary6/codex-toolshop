'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const pluginRoot = path.resolve(__dirname, '..', '..', '..');
const runner = path.join(pluginRoot, 'scripts', 'run-hook.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dispatch-codex-hooks-'));
const repo = path.join(temp, 'repo');
const data = path.join(temp, 'data');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: repo });

function run(hook, input) {
  const result = spawnSync(process.execPath, [runner, hook], {
    cwd: repo,
    env: { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: data },
    input: JSON.stringify({ cwd: repo, session_id: 's-1', turn_id: 't-1', ...input }),
    encoding: 'utf8',
    windowsHide: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function parse(output) {
  assert.ok(output, 'expected hook JSON output');
  return JSON.parse(output);
}

try {
  const session = parse(run('session_start', { hook_event_name: 'SessionStart', source: 'startup' }));
  assert.equal(session.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(session.hookSpecificOutput.additionalContext, /primary Codex agent/);
  assert.match(session.hookSpecificOutput.additionalContext, /Execute all Git commands in the primary agent, one at a time/);
  assert.ok(fs.existsSync(path.join(data, 'config.json')));
  assert.ok(fs.existsSync(path.join(repo, '.agent-dispatch-codex', 'config.json')));
  const workerProfile = path.join(repo, '.codex', 'agents', 'dispatch_worker.toml');
  assert.ok(fs.existsSync(workerProfile));
  assert.match(fs.readFileSync(workerProfile, 'utf8'), /model = "gpt-5\.6-luna"/);
  assert.match(fs.readFileSync(workerProfile, 'utf8'), /model_reasoning_effort = "max"/);
  assert.match(session.hookSpecificOutput.additionalContext, /do not leave idle agents occupying limited slots/);

  assert.equal(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '解释这一行',
  }), '');
  const prompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请审查并迁移多个插件，然后并行验证实现',
  }));
  assert.equal(prompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(prompt.hookSpecificOutput.additionalContext, /任务路由：/);
  assert.match(prompt.hookSpecificOutput.additionalContext, /dispatch_mapper|dispatch_explorer|dispatch_reviewer|dispatch_worker/);
  assert.doesNotMatch(prompt.hookSpecificOutput.additionalContext, /Agent Dispatch policy for the primary Codex agent/);

  const hardPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请实现一个困难且复杂的功能，并排查复杂调试问题',
  }));
  assert.match(hardPrompt.hookSpecificOutput.additionalContext, /dispatch_planner/);
  assert.match(hardPrompt.hookSpecificOutput.additionalContext, /dispatch_hard_worker/);
  assert.match(hardPrompt.hookSpecificOutput.additionalContext, /停止并整合/);

  const searchPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请搜索多个文件中的调用链和影响面',
  }));
  assert.match(searchPrompt.hookSpecificOutput.additionalContext, /dispatch_explorer/);
  assert.match(searchPrompt.hookSpecificOutput.additionalContext, /图刷新由 CodeMap Boost 负责/);
  assert.match(searchPrompt.hookSpecificOutput.additionalContext, /不要重复 build\/update/);

  const subagent = parse(run('subagent_start', {
    hook_event_name: 'SubagentStart',
    agent_id: 'a-1',
    agent_type: 'worker',
  }));
  assert.match(subagent.hookSpecificOutput.additionalContext, /spawned subagent/);
  assert.match(subagent.hookSpecificOutput.additionalContext, /Do not run Git commands/);

  assert.equal(run('pre_tool_use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git status' },
  }), '');
  assert.equal(run('pre_tool_use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git -C . branch -D temp' },
  }), '');
  assert.equal(run('pre_tool_use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git push origin --delete temp' },
  }), '');
  const nudge = parse(run('pre_tool_use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__heavy_remote__scan',
    tool_input: {},
  }));
  assert.equal(nudge.hookSpecificOutput.hookEventName, 'PreToolUse');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
