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

assert.equal(config.modules.session_guidance, true);
assert.equal(config.modules.prompt_guidance, true);
assert.equal(config.modules.pre_tool_nudge, false);
assert.equal(config.modules.subagent_guidance, true);
assert.match(mainAgentGuidance(config), /Keep requirements clarification, architecture and interface decisions/);
assert.match(mainAgentGuidance(config), /even when that work is sequential/);
assert.match(mainAgentGuidance(config), /no more than 3 subagents/);
assert.match(mainAgentGuidance(config), /dispatch_worker \(inherit, inherit\)/);
assert.match(mainAgentGuidance(config), /Choose roles, models, and reasoning strength/);
assert.doesNotMatch(mainAgentGuidance(config), /cost-efficient execution agent/);
assert.doesNotMatch(mainAgentGuidance(config), /clear development.*Luna/);
assert.doesNotMatch(mainAgentGuidance(config), /difficult execution.*Terra ultra/);
assert.match(mainAgentGuidance(config), /independent reviewer from the effective configuration/);
assert.match(mainAgentGuidance(config), /do not leave idle agents occupying limited slots/);
assert.match(mainAgentGuidance(config), /Execute all Git commands in the primary agent, one at a time/);
assert.match(mainAgentGuidance(config), /Agent Dispatch selects the agent; CodeMap Boost owns graph refresh/);
assert.match(mainAgentGuidance(config, true), /所有 Git 命令均由主代理串行执行/);
assert.match(mainAgentGuidance(config, true), /Agent Dispatch 只负责选代理/);
assert.match(mainAgentGuidance(config, true), /立即停止子代理/);
assert.match(mainAgentGuidance(config, true), /按风险与有效配置选 reviewer/);
assert.match(mainAgentGuidance(config, true), /独立且并行有收益时委派/);
assert.match(mainAgentGuidance(config, true), /最多 3 个子代理并发/);
assert.doesNotMatch(mainAgentGuidance(config, true), /必须并行委派/);
assert.match(subagentGuidance(config), /do not spawn or delegate/i);
assert.match(subagentGuidance(config), /every file you changed/i);
assert.match(subagentGuidance(config), /Do not run Git commands/);
assert.match(subagentGuidance(config), /Agent Dispatch selects the agent; CodeMap Boost owns graph refresh/);

assert.equal(promptNeedsDispatch('请帮我审查并迁移这个多文件插件', config), true);
assert.equal(promptNeedsDispatch('解释这一行', config), false);
assert.equal(promptGuidance('解释这一行', config), '');
assert.equal(promptGuidance('这是一段需要保留的原文。'.repeat(30), config), '', 'length alone does not request delegation');
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
assert.match(hard, /可写执行角色/);
assert.match(hard, /复杂度、上下文范围、风险/);
assert.match(hard, /主代理.*验收/);
assert.doesNotMatch(hard, /dispatch_worker|dispatch_hard_worker|gpt-5\.6-(luna|terra)|\/(?:max|ultra)/);

const plannedHard = promptGuidance('请先制定跨模块架构计划，然后实现困难的复杂调试任务', config);
assert.match(plannedHard, /dispatch_planner/);
assert.match(plannedHard, /可写执行角色/);
assert.match(plannedHard, /模型和推理强度/);
assert.match(plannedHard, /无需重复规划/);
assert.doesNotMatch(plannedHard, /必须串行两阶段|必须启动/);
assert.doesNotMatch(plannedHard, /dispatch_worker|dispatch_hard_worker|gpt-5\.6-(luna|terra)|\/(?:max|ultra)/);

assert.match(promptGuidance('请设计新的架构和接口方案', config), /dispatch_planner/);
assert.match(promptGuidance('请设计新的架构和接口方案', config), /gpt-5\.6-sol\/xhigh/);
assert.match(promptGuidance('请扫描整个仓库的跨模块调用链', config), /dispatch_mapper/);
assert.match(promptGuidance('请扫描整个仓库的跨模块调用链', config), /图刷新由 CodeMap Boost 负责/);
assert.match(promptGuidance('请搜索多个文件中的调用链和影响面', config), /dispatch_explorer/);
assert.match(promptGuidance('请搜索多个文件中的调用链和影响面', config), /不要重复 build\/update/);
const implementation = promptGuidance('请实现这个常规功能', config);
assert.match(implementation, /可写执行角色/);
assert.match(implementation, /模型和推理强度/);
assert.match(promptGuidance('请实现这个常规功能', config), /主代理.*验收/);
assert.doesNotMatch(implementation, /dispatch_worker|dispatch_hard_worker|gpt-5\.6-(luna|terra)|\/(?:max|ultra)/);
assert.doesNotMatch(implementation, /dispatch_reviewer|dispatch_deep_reviewer/);
assert.match(promptGuidance('请审查这段代码的正确性', config), /dispatch_reviewer/);
assert.match(promptGuidance('review this code for correctness', config), /dispatch_reviewer/);
assert.match(promptGuidance('请审查这段代码的正确性', config), /gpt-5\.6-terra\/high/);

// 任务范围必须实际影响路线，不能只在静态策略里写“尊重用户”。
for (const prompt of ['只读诊断这次崩溃的根因，禁止修改文件。', 'Diagnose the root cause of this crash, read-only.']) {
  const hint = promptGuidance(prompt, config);
  assert.match(hint, /只读诊断/);
  assert.doesNotMatch(hint, /可写执行角色|dispatch_planner|实现完成/);
}
for (const prompt of ['只用主代理修复复杂崩溃，不要子代理。', '按已有计划迁移跨模块接口，不要委派。', 'Main agent only: review this security patch.']) {
  assert.equal(routePrompt(prompt, config).shouldDispatch, false, prompt);
  assert.equal(promptGuidance(prompt, config), '', prompt);
}
const existingPlan = promptGuidance('按已有计划实现跨模块接口迁移，不要重新规划。', config);
assert.match(existingPlan, /常规实现/);
assert.match(existingPlan, /优先图查询/);
assert.doesNotMatch(existingPlan, /dispatch_planner|非琐碎计划/);
for (const prompt of [
  '按已有实现计划实现跨模块迁移',
  '已有实现方案，继续实现跨模块迁移',
  '按已有执行计划实现跨模块迁移',
  '已有执行方案，继续实现跨模块迁移',
  '按现有实现计划实现跨模块迁移',
  '现有实现方案，继续实现跨模块迁移',
  '按现有执行计划实现跨模块迁移',
  '现有执行方案，继续实现跨模块迁移',
  'Implement the cross-module migration using the existing implementation plan.',
  'Implement the cross-module migration using the existing execution plan.',
  'Implement the cross-module migration using the approved implementation plan.',
  'Implement the cross-module migration using the approved execution plan.',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.existingPlan, true, prompt);
  assert.equal(route.category, 'implementation', prompt);
  assert.match(promptGuidance(prompt, config), /常规实现/, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_planner|非琐碎计划/, prompt);
}
for (const prompt of [
  '还没有实现计划，请规划跨模块迁移',
  '请制定实现计划，然后实现跨模块迁移',
  '请制定执行方案，然后实现跨模块迁移',
  'Create an implementation plan for the cross-module migration.',
  'Create an execution plan for the cross-module migration.',
]) {
  assert.equal(routePrompt(prompt, config).existingPlan, false, prompt);
  assert.equal(routePrompt(prompt, config).category, 'plan', prompt);
  assert.match(promptGuidance(prompt, config), /dispatch_planner/, prompt);
}
for (const prompt of [
  '按已有实现计划只读分析跨模块迁移，禁止修改文件',
  'Inspect the cross-module migration using the approved execution plan, read-only.',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.existingPlan, true, prompt);
  assert.equal(route.category, 'broad-search', prompt);
  assert.equal(route.readOnly, true, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /可写执行角色|dispatch_planner/, prompt);
}
for (const prompt of [
  '只用主代理，按现有执行方案实现跨模块迁移',
  'Main agent only: implement the cross-module migration using the existing implementation plan.',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.existingPlan, true, prompt);
  assert.equal(route.category, 'primary-only', prompt);
  assert.equal(route.shouldDispatch, false, prompt);
  assert.equal(promptGuidance(prompt, config), '', prompt);
}
for (const prompt of ['What depends on the auth module?', 'Find all callers of authService.', '请分析 auth 模块的依赖关系']) {
  assert.match(promptGuidance(prompt, config), /dispatch_explorer/);
  assert.match(promptGuidance(prompt, config), /优先图查询/);
}
for (const prompt of ['Please inspect this patch for regressions.', 'Please check this change for regressions.', '审查跨模块调用链修改']) {
  assert.match(promptGuidance(prompt, config), /dispatch_reviewer/);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_mapper/);
}
for (const prompt of ['Review the spelling of the word security in README only.', 'Review the production deployment wording in docs only.', 'Review the security wording in CHANGELOG only.']) {
  assert.equal(promptGuidance(prompt, config), '', prompt);
}
const narrowRisk = promptGuidance('Fix this permission bug in one file.', config);
assert.match(narrowRisk, /主代理处理/);
assert.match(narrowRisk, /契约|证据/);
assert.doesNotMatch(narrowRisk, /只读|可写执行角色|dispatch_/);
assert.equal(promptGuidance('只读检查一个文件里的崩溃原因，不修改', config), '');
assert.doesNotMatch(promptGuidance('Explain the current architecture.', config), /dispatch_planner/);
assert.match(promptGuidance('Fix this permission bug across modules.', config), /已有授权|现有授权/);
assert.match(promptGuidance('Use only one agent to fix this complex crash.', config), /代理数量或并行限制优先/);

const overridden = JSON.parse(JSON.stringify(config));
overridden.agent_profiles.profiles.dispatch_reviewer.model = 'gpt-6-astra';
overridden.agent_profiles.profiles.dispatch_reviewer.model_reasoning_effort = 'low';
assert.match(promptGuidance('review this code for correctness', overridden), /gpt-6-astra\/low/);
for (const compact of [false, true]) {
  const guidance = mainAgentGuidance(overridden, compact);
  assert.match(guidance, /dispatch_reviewer \(gpt-6-astra, low\)/);
  assert.doesNotMatch(guidance, /Terra high|Sol xhigh/, 'fixed role recommendations must not override profile settings');
}
for (const prompt of ['请设计新的架构和接口方案', '请审查这段代码的正确性', '请搜索多个文件中的调用链']) {
  const guidance = promptGuidance(prompt, config);
  assert.doesNotMatch(guidance, /必须启动|必须委派/);
  assert.match(guidance, /用户显式偏好/);
  assert.match(guidance, /宿主实际支持的模型\/推理组合/);
}

const disabled = JSON.parse(JSON.stringify(config));
disabled.agent_profiles.profiles.dispatch_deep_reviewer.enabled = false;
disabled.agent_profiles.profiles.dispatch_reviewer.enabled = false;
disabled.agent_profiles.profiles.dispatch_mapper.enabled = false;
disabled.agent_profiles.profiles.dispatch_worker.enabled = false;
disabled.agent_profiles.profiles.dispatch_hard_worker.enabled = false;
assert.doesNotMatch(promptGuidance('请审查安全权限风险', disabled), /dispatch_deep_reviewer|dispatch_reviewer/);
assert.match(promptGuidance('请审查安全权限风险', disabled), /主代理/);
assert.doesNotMatch(promptGuidance('请扫描整个仓库的跨模块调用链', disabled), /dispatch_mapper/);
assert.match(promptGuidance('请扫描整个仓库的跨模块调用链', disabled), /dispatch_explorer/);
assert.match(promptGuidance('请实现这个常规功能', disabled), /当前没有启用的可写执行角色，由主代理直接完成/);

assert.equal(toolNudge({ tool_name: 'apply_patch', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__code_review_graph__get_minimal_context_tool', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__context-mode__ctx_execute', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__plugin_context-mode_context-mode__ctx_search', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__serena__find_symbol', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__serena-cross-platform__find_symbol', tool_input: {} }, config), '');
assert.match(toolNudge({ tool_name: 'mcp__heavy_remote__scan', tool_input: {} }, config), /不能仅因工具名称委派/);
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git status' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git branch -D temp' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git push origin --delete temp' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git log > out.txt' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'reg query HKCU\\Software\\AgentDispatch' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: "bash -lc 'reg query HKCU\\Software\\AgentDispatch'" } }, config), '');
assert.match(toolNudge({ tool_name: 'Bash', tool_input: { command: 'reg add HKCU\\Software\\AgentDispatch /v Enabled /t REG_DWORD /d 1 /f' } }, config), /注册表写入/);
for (const command of [
  'printf ok',
  'echo ok',
  'sed -n 1,20p file.txt',
  'for x in a; do echo "$x"; done',
  'while false; do echo never; done',
  'if true; then echo ok; fi',
  'unknown-heavy-tool scan',
  'git status $(unknown-heavy-tool)',
  'git status && unknown-heavy-tool scan',
  'echo ok;rm -rf .',
  'git log > out.txt',
  "bash -lc 'echo nested'",
]) {
  assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command } }, config), '');
}
