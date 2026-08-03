'use strict';

const assert = require('assert').strict;
const { loadDefaults } = require('../lib/config');
const {
  mainAgentGuidance,
  promptNeedsDispatch,
  subagentGuidance,
  toolNudge,
} = require('../lib/guidance');

const config = loadDefaults();

assert.match(mainAgentGuidance(config), /Keep requirements clarification, architecture and interface decisions/);
assert.match(mainAgentGuidance(config), /even when that work is sequential/);
assert.match(mainAgentGuidance(config), /no more than 3 subagents/);
assert.match(mainAgentGuidance(config), /dispatch_worker \(gpt-5\.6-luna, max\)/);
assert.match(mainAgentGuidance(config), /use a high-reasoning reviewer only when an independent review is justified by risk/);
assert.match(mainAgentGuidance(config), /do not leave idle agents occupying limited slots/);
assert.match(mainAgentGuidance(config), /Execute all Git commands in the primary agent, one at a time/);
assert.match(mainAgentGuidance(config, true), /所有 Git 命令均由主代理串行执行/);
assert.match(mainAgentGuidance(config, true), /立即停止子代理/);
assert.match(mainAgentGuidance(config, true), /只有高风险范围确实需要独立复核时/);
assert.match(subagentGuidance(config), /do not spawn or delegate/i);
assert.match(subagentGuidance(config), /every file you changed/i);
assert.match(subagentGuidance(config), /Do not run Git commands/);

assert.equal(promptNeedsDispatch('请帮我审查并迁移这个多文件插件', config), true);
assert.equal(promptNeedsDispatch('解释这一行', config), false);

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
assert.match(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git status $(unknown-heavy-tool)' } }, config), /需要调度判断/);
assert.match(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git status && unknown-heavy-tool scan' } }, config), /需要调度判断/);
assert.match(toolNudge({ tool_name: 'Bash', tool_input: { command: 'echo ok;rm -rf .' } }, config), /需要调度判断/);
