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
  assert.doesNotMatch(fs.readFileSync(workerProfile, 'utf8'), /^model = /m);
  assert.doesNotMatch(fs.readFileSync(workerProfile, 'utf8'), /^model_reasoning_effort = /m);
  assert.match(session.hookSpecificOutput.additionalContext, /do not leave idle agents occupying limited slots/);

  const compactSession = parse(run('session_start', { hook_event_name: 'SessionStart', source: 'compact' }));
  assert.match(compactSession.hookSpecificOutput.additionalContext, /独立且并行有收益时委派/);
  assert.match(compactSession.hookSpecificOutput.additionalContext, /最多 3 个子代理并发/);
  assert.match(compactSession.hookSpecificOutput.additionalContext, /CodeMap MCP 可能 deferred/);
  assert.doesNotMatch(compactSession.hookSpecificOutput.additionalContext, /Agent Dispatch policy for the primary Codex agent/);

  for (const source of ['resume', 'clear']) {
    const fullSession = parse(run('session_start', { hook_event_name: 'SessionStart', source }));
    assert.match(fullSession.hookSpecificOutput.additionalContext, /Agent Dispatch policy for the primary Codex agent/);
    assert.doesNotMatch(fullSession.hookSpecificOutput.additionalContext, /独立且并行有收益时委派/);
  }

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
  assert.match(hardPrompt.hookSpecificOutput.additionalContext, /可写执行角色/);
  assert.match(hardPrompt.hookSpecificOutput.additionalContext, /模型和推理强度/);
  assert.match(hardPrompt.hookSpecificOutput.additionalContext, /主代理.*验收/);
  assert.doesNotMatch(hardPrompt.hookSpecificOutput.additionalContext, /dispatch_worker|dispatch_hard_worker|gpt-5\.6-(luna|terra)|\/(?:max|ultra)/);

  const plannedHardPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请先制定跨模块架构计划，然后实现困难的复杂调试任务',
  }));
  assert.match(plannedHardPrompt.hookSpecificOutput.additionalContext, /dispatch_planner/);
  assert.match(plannedHardPrompt.hookSpecificOutput.additionalContext, /可写执行角色/);
  assert.match(plannedHardPrompt.hookSpecificOutput.additionalContext, /停止并整合/);
  assert.doesNotMatch(plannedHardPrompt.hookSpecificOutput.additionalContext, /dispatch_worker|dispatch_hard_worker|gpt-5\.6-(luna|terra)|\/(?:max|ultra)/);

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
  for (const command of [
    'printf ok',
    'echo ok',
    'sed -n 1,20p file.txt',
    'for x in a; do echo "$x"; done',
    'while false; do echo never; done',
    'if true; then echo ok; fi',
    'unknown-heavy-tool scan',
    'echo ok;rm -rf .',
    'bash -lc \'echo nested\'',
  ]) {
    assert.equal(run('pre_tool_use', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    }), '');
  }
  assert.equal(run('pre_tool_use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'reg query HKCU\\Software\\AgentDispatch' },
  }), '');
  assert.equal(run('pre_tool_use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: "bash -lc 'reg query HKCU\\Software\\AgentDispatch'" },
  }), '');
  assert.equal(run('pre_tool_use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'reg add HKCU\\Software\\AgentDispatch /v Enabled /t REG_DWORD /d 1 /f' },
  }), '');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    modules: { pre_tool_nudge: true },
  }));
  const registryWrite = parse(run('pre_tool_use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'reg add HKCU\\Software\\AgentDispatch /v Enabled /t REG_DWORD /d 1 /f' },
  }));
  assert.match(registryWrite.hookSpecificOutput.additionalContext, /注册表写入/);
  assert.match(registryWrite.hookSpecificOutput.additionalContext, /主代理/);
  assert.doesNotMatch(registryWrite.hookSpecificOutput.additionalContext, /command is not lightweight/);
  const wrappedRegistryWrite = parse(run('pre_tool_use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: {
      command: "bash -lc 'reg add HKCU\\Software\\AgentDispatch /v Enabled /t REG_DWORD /d 1 /f'",
    },
  }));
  assert.match(wrappedRegistryWrite.hookSpecificOutput.additionalContext, /注册表写入/);
  const nudge = parse(run('pre_tool_use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__heavy_remote__scan',
    tool_input: {},
  }));
  assert.equal(nudge.hookSpecificOutput.hookEventName, 'PreToolUse');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
