'use strict';

const assert = require('assert').strict;
const { loadDefaults } = require('../lib/config');
const {
  mainAgentGuidance,
  promptNeedsDispatch,
  promptGuidance,
  routePrompt,
  subagentGuidance,
  toolNudge,
} = require('../lib/guidance');

const config = loadDefaults();

assert.match(mainAgentGuidance(config), /Keep requirements clarification, architecture and interface decisions/);
assert.match(mainAgentGuidance(config), /even when that work is sequential/);
assert.match(mainAgentGuidance(config), /no more than 3 subagents/);
assert.match(mainAgentGuidance(config), /dispatch_worker \(gpt-5\.6-luna, max\)/);
assert.match(mainAgentGuidance(config), /use Terra high for requested routine independent review and Sol xhigh only for high-risk review/);
assert.match(mainAgentGuidance(config), /do not leave idle agents occupying limited slots/);
assert.match(mainAgentGuidance(config), /Execute all Git commands in the primary agent, one at a time/);
assert.match(mainAgentGuidance(config), /Agent Dispatch selects the agent; CodeMap Boost owns graph refresh/);
assert.match(mainAgentGuidance(config), /deferred.*ALL_TOOLS.*top-level list alone/);
assert.match(mainAgentGuidance(config, true), /所有 Git 命令均由主代理串行执行/);
assert.match(mainAgentGuidance(config, true), /Agent Dispatch 只负责选代理/);
assert.match(mainAgentGuidance(config, true), /deferred.*ALL_TOOLS.*顶层列表判断/);
assert.match(mainAgentGuidance(config, true), /立即停止子代理/);
assert.match(mainAgentGuidance(config, true), /高风险审查才用 Sol xhigh/);
assert.match(mainAgentGuidance(config, true), /独立且并行有收益时委派/);
assert.match(mainAgentGuidance(config, true), /最多 3 个子代理并发/);
assert.doesNotMatch(mainAgentGuidance(config, true), /必须并行委派/);
assert.match(subagentGuidance(config), /do not spawn or delegate/i);
assert.match(subagentGuidance(config), /every file you changed/i);
assert.match(subagentGuidance(config), /Do not run Git commands/);
assert.match(subagentGuidance(config), /deferred.*ALL_TOOLS.*top-level list alone/);
assert.match(subagentGuidance(config), /Agent Dispatch selects the agent; CodeMap Boost owns graph refresh/);

assert.equal(promptNeedsDispatch('请帮我审查并迁移这个多文件插件', config), true);
assert.equal(promptNeedsDispatch('解释这一行', config), false);
assert.equal(promptGuidance('解释这一行', config), '');
assert.equal(routePrompt('查找单个符号 Foo', config).category, 'generic');
assert.equal(routePrompt('查找单个符号 Foo', config).shouldDispatch, false);
assert.equal(routePrompt('设计一个按钮', config).shouldDispatch, false);
assert.equal(routePrompt('请实现一个 getter', config).shouldDispatch, false);
assert.equal(routePrompt('请先制定计划然后实现用户模块', config).category, 'plan');

const highRisk = promptGuidance('请审查安全权限和生产并发风险', config);
assert.match(highRisk, /高风险审查/);
assert.match(highRisk, /dispatch_deep_reviewer/);
assert.doesNotMatch(highRisk, /dispatch_worker/);
assert.match(promptGuidance('请查找这个文件并审查安全漏洞', config), /dispatch_deep_reviewer/);

const hard = promptGuidance('请实现一个困难且复杂的功能，并排查复杂调试问题', config);
assert.match(hard, /dispatch_hard_worker/);
assert.match(hard, /主代理.*验收/);
assert.doesNotMatch(hard, /dispatch_planner|gpt-5\.6-sol/);

const plannedHard = promptGuidance('请先制定跨模块架构计划，然后实现困难的复杂调试任务', config);
assert.match(plannedHard, /dispatch_planner/);
assert.match(plannedHard, /dispatch_hard_worker/);
assert.match(plannedHard, /停止并整合/);
assert.ok(plannedHard.indexOf('dispatch_planner') < plannedHard.indexOf('dispatch_hard_worker'));

assert.match(promptGuidance('请设计新的架构和接口方案', config), /dispatch_planner/);
assert.match(promptGuidance('请设计新的架构和接口方案', config), /gpt-5\.6-sol\/xhigh/);
assert.match(promptGuidance('请扫描整个仓库的跨模块调用链', config), /dispatch_mapper/);
assert.match(promptGuidance('请扫描整个仓库的跨模块调用链', config), /图刷新由 CodeMap Boost 负责/);
assert.match(promptGuidance('请搜索多个文件中的调用链和影响面', config), /dispatch_explorer/);
assert.match(promptGuidance('请搜索多个文件中的调用链和影响面', config), /不要重复 build\/update/);
assert.match(promptGuidance('请实现这个常规功能', config), /dispatch_worker/);
assert.match(promptGuidance('请实现这个常规功能', config), /主代理.*验收/);
assert.doesNotMatch(promptGuidance('请实现这个常规功能', config), /dispatch_reviewer|dispatch_deep_reviewer/);
assert.match(promptGuidance('请审查这段代码的正确性', config), /dispatch_reviewer/);
assert.match(promptGuidance('review this code for correctness', config), /dispatch_reviewer/);
assert.match(promptGuidance('请审查这段代码的正确性', config), /gpt-5\.6-terra\/high/);

const disabled = JSON.parse(JSON.stringify(config));
disabled.agent_profiles.profiles.dispatch_deep_reviewer.enabled = false;
disabled.agent_profiles.profiles.dispatch_reviewer.enabled = false;
disabled.agent_profiles.profiles.dispatch_mapper.enabled = false;
disabled.agent_profiles.profiles.dispatch_worker.enabled = false;
assert.doesNotMatch(promptGuidance('请审查安全权限风险', disabled), /dispatch_deep_reviewer|dispatch_reviewer/);
assert.match(promptGuidance('请审查安全权限风险', disabled), /主代理/);
assert.doesNotMatch(promptGuidance('请扫描整个仓库的跨模块调用链', disabled), /dispatch_mapper/);
assert.match(promptGuidance('请扫描整个仓库的跨模块调用链', disabled), /dispatch_explorer/);
assert.doesNotMatch(promptGuidance('请实现这个常规功能', disabled), /dispatch_worker/);
assert.match(promptGuidance('请实现这个常规功能', disabled), /主代理/);

assert.equal(toolNudge({ tool_name: 'apply_patch', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__code_review_graph__get_minimal_context_tool', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__context-mode__ctx_execute', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__plugin_context-mode_context-mode__ctx_search', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__serena__find_symbol', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__serena-cross-platform__find_symbol', tool_input: {} }, config), '');
assert.match(toolNudge({ tool_name: 'mcp__heavy_remote__scan', tool_input: {} }, config), /必须委派子代理/);
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git status' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git branch -D temp' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git push origin --delete temp' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git log > out.txt' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'reg query HKCU\\Software\\AgentDispatch' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: "bash -lc 'reg query HKCU\\Software\\AgentDispatch'" } }, config), '');
assert.match(toolNudge({ tool_name: 'Bash', tool_input: { command: 'reg add HKCU\\Software\\AgentDispatch /v Enabled /t REG_DWORD /d 1 /f' } }, config), /注册表写入/);
assert.match(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git status $(unknown-heavy-tool)' } }, config), /需要调度判断/);
assert.match(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git status && unknown-heavy-tool scan' } }, config), /需要调度判断/);
assert.match(toolNudge({ tool_name: 'Bash', tool_input: { command: 'echo ok;rm -rf .' } }, config), /需要调度判断/);
