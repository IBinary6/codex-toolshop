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
assert.match(mainAgentGuidance(config), /Keep requirements clarification, key plan and public-contract decisions/);
assert.match(mainAgentGuidance(config), /even when that work is sequential/);
assert.match(mainAgentGuidance(config), /no more than 3 subagents/);
assert.match(mainAgentGuidance(config), /dispatch_worker \(inherit, inherit\)/);
assert.match(mainAgentGuidance(config), /Choose among enabled candidates/);
assert.match(mainAgentGuidance(config), /total task cost including context, rework, review, and latency/);
assert.match(mainAgentGuidance(config), /explicitly pass model and effort/);
assert.match(mainAgentGuidance(config), /configured low-cost candidate \(gpt-5\.6-luna\/max\)/);
assert.match(mainAgentGuidance(config), /Delegate bounded .*configured low-cost candidate \(gpt-5\.6-luna\/max\) by default/);
assert.match(mainAgentGuidance(config), /code-evidence/);
assert.doesNotMatch(mainAgentGuidance(config), /cost-efficient execution agent/);
assert.doesNotMatch(mainAgentGuidance(config), /clear development.*Luna/);
assert.doesNotMatch(mainAgentGuidance(config), /difficult execution.*Terra ultra/);
assert.match(mainAgentGuidance(config), /independently review non-trivial deliverables/);
assert.match(mainAgentGuidance(config), /reuses the original writer for a bounded fix/);
assert.match(mainAgentGuidance(config), /reruns affected checks, and reviews again/);
assert.match(mainAgentGuidance(config), /Only a defect supported by concrete evidence and affecting the current acceptance target can block/);
assert.match(mainAgentGuidance(config), /Missing context, hypothetical risks, and style suggestions are non-blocking/);
assert.match(mainAgentGuidance(config), /do not trigger automatic rework or stop for confirmation/);
assert.match(mainAgentGuidance(config), /do not leave idle agents occupying limited slots/);
assert.match(mainAgentGuidance(config), /ordinary single-command Git CLI quiet/);
assert.match(mainAgentGuidance(config), /complete local commit preparation/);
assert.match(mainAgentGuidance(config), /validate the snapshot before the final commit/);
assert.match(mainAgentGuidance(config), /final commit, remote operations, and history rewrites remain with the primary agent/);
assert.match(mainAgentGuidance(config), /Agent Dispatch selects the agent; CodeMap Boost owns graph refresh/);
assert.match(mainAgentGuidance(config), /content or product production/);
assert.match(mainAgentGuidance(config), /builds and code tests are not universal requirements/);
assert.match(mainAgentGuidance(config), /does not authorize external publishing or sending/);
assert.match(mainAgentGuidance(config, true), /普通单条 Git CLI 保持安静并由主代理串行执行/);
assert.match(mainAgentGuidance(config, true), /完整本地提交准备/);
assert.match(mainAgentGuidance(config, true), /主代理校验快照后执行 commit、远程操作和历史改写/);
assert.doesNotMatch(mainAgentGuidance(config, true), /pre_tool_nudge/);
assert.match(mainAgentGuidance(config, true), /Agent Dispatch 只负责选代理/);
assert.match(mainAgentGuidance(config, true), /立即停止子代理/);
assert.match(mainAgentGuidance(config, true), /按风险与有效配置选 reviewer/);
assert.match(mainAgentGuidance(config, true), /独立且并行有收益时委派/);
assert.match(mainAgentGuidance(config, true), /最多 3 个子代理并发/);
assert.doesNotMatch(mainAgentGuidance(config, true), /必须并行委派/);
assert.match(mainAgentGuidance(config, true), /整个任务的总成本/);
assert.match(mainAgentGuidance(config, true), /未固定模型的 writer 必须显式传 model 与 effort/);
assert.match(mainAgentGuidance(config, true), /低成本路由优先/);
assert.match(mainAgentGuidance(config, true), /代码任务按阶段取证/);
assert.match(mainAgentGuidance(config, true), /原生 TOML 固定值优先于 spawn 参数/);
assert.match(mainAgentGuidance(config, true), /当前完整历史 fork 不接受覆盖/);
assert.match(mainAgentGuidance(config, true), /复用原 writer 有界修复/);
assert.match(mainAgentGuidance(config, true), /重跑受影响检查并复查/);
assert.match(mainAgentGuidance(config, true), /只有具体证据证明影响本次验收目标的缺陷才阻塞/);
assert.match(mainAgentGuidance(config, true), /上下文缺失、假设性风险和风格建议作为非阻塞提示/);
assert.match(mainAgentGuidance(config, true), /不自动返修，也不触发确认停工/);
assert.match(mainAgentGuidance(config, true), /按交付物选择验证证据/);
assert.match(mainAgentGuidance(config, true), /不新增对外发布、发送、付费、生产环境或真实数据变更的授权/);
const lowCostDisabledSession = JSON.parse(JSON.stringify(config));
lowCostDisabledSession.policy.low_cost.enabled = false;
for (const compact of [false, true]) {
  const guidance = mainAgentGuidance(lowCostDisabledSession, compact);
  assert.doesNotMatch(guidance, /Prefer the configured low-cost candidate|低成本路由优先/);
  assert.match(guidance, /For code work|代码任务按阶段取证/);
}
const customLowCostSession = JSON.parse(JSON.stringify(config));
customLowCostSession.policy.low_cost.model = 'gpt-5.5';
customLowCostSession.policy.low_cost.model_reasoning_effort = 'high';
assert.match(
  mainAgentGuidance(customLowCostSession),
  /configured low-cost candidate \(gpt-5\.5\/high\)/
);
assert.match(mainAgentGuidance(customLowCostSession, true), /低成本路由优先：.*gpt-5\.5\/high/);
assert.doesNotMatch(mainAgentGuidance(customLowCostSession), /configured low-cost candidate \(gpt-5\.6-luna\/max\)/);
assert.doesNotMatch(mainAgentGuidance(customLowCostSession, true), /指定的合规角色（gpt-5\.6-luna\/max）/);
assert.match(subagentGuidance(config), /do not spawn or delegate/i);
assert.match(subagentGuidance(config), /every file you changed/i);
assert.match(subagentGuidance(config), /Do not run Git commands/);
assert.match(subagentGuidance(config), /complete local commit preparation/);
assert.match(subagentGuidance(config), /stage only assigned files/);
assert.match(subagentGuidance(config), /HEAD\/index tree OIDs/);
assert.match(subagentGuidance(config), /primary validates the snapshot and commits/);
assert.match(subagentGuidance(config), /CodeMap Boost only for explicit code structure or code-review work/);
assert.match(subagentGuidance(config), /validation methods, evidence, results/);
assert.match(subagentGuidance(config), /do not add authority to publish or send externally/);

assert.equal(promptNeedsDispatch('请帮我审查并迁移这个多文件插件', config), true);
assert.equal(promptNeedsDispatch('解释这一行', config), false);
assert.equal(promptGuidance('解释这一行', config), '');
assert.equal(promptGuidance('这是一段需要保留的原文。'.repeat(30), config), '', 'length alone does not request delegation');

for (const command of [
  'git commit -m "fix: update parser"',
  'git log --grep=review',
  'git diff -- src/architecture.js',
  'git show HEAD:src/architecture.js',
  'git status',
  'git.exe status',
  'git -C . status',
]) {
  const route = routePrompt(command, config);
  assert.equal(route.shouldDispatch, false, command);
  assert.equal(route.reason, 'pure Git CLI command', command);
}
const mixedGitCommand = routePrompt('git status && rg architecture', config);
assert.equal(mixedGitCommand.category, 'plan');
assert.equal(mixedGitCommand.shouldDispatch, true, 'mixed Git/non-Git commands retain task routing');
const naturalLanguageCommit = routePrompt(
  '请让一个可写代理完成本地提交准备并整理摘要',
  config
);
assert.equal(naturalLanguageCommit.category, 'execution');
assert.equal(naturalLanguageCommit.shouldDispatch, true, 'natural-language delegation remains routable');
assert.equal(routePrompt('查找单个符号 Foo', config).category, 'generic');
assert.equal(routePrompt('查找单个符号 Foo', config).shouldDispatch, false);
assert.equal(routePrompt('设计一个按钮', config).shouldDispatch, false);
assert.equal(routePrompt('请实现一个 getter', config).shouldDispatch, false);
assert.equal(routePrompt('请先制定计划然后实现用户模块', config).category, 'plan');

for (const [prompt, kind] of [
  ['检索最近构建日志并摘录失败原因', 'logs'],
  ['读取这些 Markdown 文档，汇总重复条目', 'documents'],
  ['完成常规文档读写并保留原格式', 'documents'],
  ['运行现有 CTest 用例，汇总失败输出', 'established-tests'],
  ['查找源码中所有调用方和影响面', 'code-evidence'],
  ['按模板批量更新文档中的版本号', 'documents'],
  ['从 CSV 提取字段并去重统计', 'structured-data'],
  ['读取 JSON 汇总指定字段', 'structured-data'],
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'low-cost', prompt);
  assert.equal(route.lowCostKind, kind, prompt);
  assert.equal(route.shouldDispatch, true, prompt);
  const guidance = promptGuidance(prompt, config);
  assert.match(guidance, /低成本/, prompt);
  assert.match(guidance, /默认委派给/, prompt);
  assert.match(guidance, /gpt-5\.6-luna\/max/, prompt);
  assert.match(guidance, /dispatch_luna_worker/, prompt);
  assert.doesNotMatch(guidance, /dispatch_(?:terra|sol|astra)_worker/, prompt);
}
for (const [prompt, category] of [
  ['新增单元测试用例覆盖接口', 'implementation'],
  ['请新增复杂单元测试用例', 'hard-task'],
  ['增加回归测试用例覆盖接口', 'implementation'],
  ['执行既定测试验收结账流程', 'verification'],
  ['运行现有测试并汇总失败', 'verification'],
  ['Write a complex implementation for a JSON parser', 'hard-task'],
  ['编写一个复杂 JSON 处理器', 'hard-task'],
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, category, prompt);
  assert.notEqual(route.category, 'low-cost', prompt);
}
assert.equal(routePrompt('验证代码的现有测试', config).category, 'low-cost');
assert.equal(routePrompt('验证代码的现有测试', config).lowCostKind, 'established-tests');
assert.match(promptGuidance('执行既定测试验收结账流程', config), /验证执行/);
assert.doesNotMatch(promptGuidance('执行既定测试验收结账流程', config), /低成本|dispatch_luna_worker/);
assert.equal(routePrompt('Run the existing test suite against the prototype', config).category, 'verification');
assert.equal(routePrompt('Run the existing test suite for the source code', config).category, 'low-cost');
assert.match(promptGuidance('编写一个复杂 JSON 处理器', config), /困难任务/);
assert.doesNotMatch(promptGuidance('编写一个复杂 JSON 处理器', config), /低成本机械结构化数据整理/);
assert.equal(routePrompt('写入一份 JSON 文档', config).category, 'execution');
assert.equal(routePrompt('写入指定 JSON 字段', config).category, 'low-cost');
assert.equal(routePrompt('查找源码中所有调用方和影响面', config).needsGraph, true);
const mixedEvidence = routePrompt('根据构建日志修复复杂崩溃，并补回归测试', config);
assert.equal(mixedEvidence.category, 'hard-task');
assert.equal(mixedEvidence.lowCostKind, 'logs');
assert.equal(mixedEvidence.lowCostEvidence, true);
assert.match(promptGuidance('根据构建日志修复复杂崩溃，并补回归测试', config), /先拆分.*低成本/);
assert.match(promptGuidance('根据构建日志修复复杂崩溃，并补回归测试', config), /gpt-5\.6-luna\/max/);
assert.match(promptGuidance('根据构建日志修复复杂崩溃，并补回归测试', config), /可写执行角色/);
assert.equal(routePrompt('检索构建日志里的 crash 和 error', config).category, 'low-cost');
assert.match(promptGuidance('检索构建日志里的 crash 和 error', config), /gpt-5\.6-luna\/max/);
assert.equal(routePrompt('请优化 Agent Dispatch，让日志读取交给 Luna Max', config).category, 'generic');
assert.equal(promptGuidance('请优化 Agent Dispatch，让日志读取交给 Luna Max', config), '');
assert.equal(routePrompt('写单元测试覆盖新的接口行为', config).category, 'implementation');
assert.match(promptGuidance('写单元测试覆盖新的接口行为', config), /常规实现/);
assert.equal(routePrompt('写单元测试覆盖新的接口行为', config).lowCostEvidence, false);
const readOnlyDocuments = promptGuidance('只读读取 Markdown 文档并汇总重复条目，不修改文件', config);
assert.match(readOnlyDocuments, /保持只读/);
assert.doesNotMatch(readOnlyDocuments, /文档写入只限/);
assert.equal(routePrompt('只用主代理检索构建日志，不要子代理', config).category, 'primary-only');
assert.equal(promptGuidance('只用主代理检索构建日志，不要子代理', config), '');
assert.equal(routePrompt('请讨论低成本模型配置，不执行任务', config).category, 'generic');

const highRisk = promptGuidance('请审查安全权限和生产并发风险', config);
assert.match(highRisk, /高风险审查/);
assert.match(highRisk, /dispatch_deep_reviewer/);
assert.doesNotMatch(highRisk, /dispatch_worker/);
assert.match(promptGuidance('请查找这个文件并审查安全漏洞', config), /dispatch_deep_reviewer/);

const hard = promptGuidance('请实现一个困难且复杂的功能，并排查复杂调试问题', config);
assert.match(hard, /可写执行角色/);
assert.match(hard, /按实际复杂度从已启用候选选择/);
assert.match(hard, /主代理.*验收/);
assert.doesNotMatch(hard, /dispatch_worker|dispatch_hard_worker|gpt-5\.6-(luna|terra)|\/(?:max|ultra)/);

const plannedHard = promptGuidance('请先制定跨模块架构计划，然后实现困难的复杂调试任务', config);
assert.match(plannedHard, /dispatch_planner/);
assert.match(plannedHard, /可写执行角色/);
assert.match(plannedHard, /model 与 effort/);
assert.match(plannedHard, /无需重复规划/);
assert.doesNotMatch(plannedHard, /必须串行两阶段|必须启动/);
assert.doesNotMatch(plannedHard, /dispatch_worker|dispatch_hard_worker|gpt-5\.6-(luna|terra)|\/(?:max|ultra)/);

assert.match(promptGuidance('请设计新的架构和接口方案', config), /dispatch_planner/);
assert.match(promptGuidance('请设计新的架构和接口方案', config), /gpt-6-astra\/xhigh/);
assert.match(promptGuidance('请扫描整个仓库的跨模块调用链', config), /dispatch_luna_worker/);
assert.match(promptGuidance('请扫描整个仓库的跨模块调用链', config), /gpt-5\.6-luna\/max/);
assert.match(promptGuidance('请扫描整个仓库的跨模块调用链', config), /图刷新由 CodeMap Boost 负责/);
assert.match(promptGuidance('请搜索多个文件中的调用链和影响面', config), /dispatch_luna_worker/);
assert.match(promptGuidance('请搜索多个文件中的调用链和影响面', config), /gpt-5\.6-luna\/max/);
assert.match(promptGuidance('请搜索多个文件中的调用链和影响面', config), /不要重复 build\/update/);
const implementation = promptGuidance('请实现这个常规功能', config);
assert.match(implementation, /可写执行角色/);
assert.match(implementation, /model 与 effort/);
assert.match(promptGuidance('请实现这个常规功能', config), /主代理.*验收/);
assert.doesNotMatch(implementation, /dispatch_worker|dispatch_hard_worker|gpt-5\.6-(luna|terra)|\/(?:max|ultra)/);
assert.match(implementation, /针对性验证后，再独立审查非琐碎成果/);
assert.match(implementation, /复用原 writer 有界修复/);
assert.match(implementation, /有具体证据且影响本次验收/);
assert.match(implementation, /提示项不自动返修或停工/);
assert.doesNotMatch(implementation, /dispatch_reviewer|dispatch_deep_reviewer/);
assert.match(promptGuidance('请审查这段代码的正确性', config), /dispatch_reviewer/);
assert.match(promptGuidance('review this code for correctness', config), /dispatch_reviewer/);
assert.match(promptGuidance('请审查这段代码的正确性', config), /gpt-6-astra\/xhigh/);

for (const name of ['dispatch_reviewer', 'dispatch_deep_reviewer']) {
  const instructions = config.agent_profiles.profiles[name].developer_instructions;
  assert.match(instructions, /Exclude vendored third-party implementations/);
  assert.match(instructions, /thridpart/);
  assert.match(instructions, /Preserve local clang-format protection/i);
  assert.match(instructions, /task intent, acceptance criteria, real entry point/);
  assert.match(instructions, /For code review, also verify build configuration and call contracts/);
  assert.match(instructions, /Block only defects that concrete evidence shows affect the current acceptance target/);
  assert.match(instructions, /Missing context, hypothetical risks, and style suggestions are non-blocking/);
  assert.match(instructions, /#if DEBUG, #if _DEBUG, #if DBG, and KdBreakPoint/);
  assert.match(instructions, /preserve debug-scoped breakpoints and instrumentation/i);
  assert.match(instructions, /required Release or delivery path/);
  assert.match(instructions, /not a permanent exemption for debug code/i);
}

for (const name of [
  'dispatch_worker',
  'dispatch_hard_worker',
  'dispatch_luna_worker',
  'dispatch_terra_worker',
  'dispatch_sol_worker',
  'dispatch_astra_worker',
]) {
  const profile = config.agent_profiles.profiles[name];
  assert.match(profile.description, /deliverable/i, name);
  assert.match(profile.developer_instructions, /does not authorize external publishing or sending/i, name);
  assert.match(profile.developer_instructions, /(?:validation evidence appropriate to (?:that |the )?deliverable|validate the deliverable .* appropriate evidence)/i, name);
}
assert.match(config.agent_profiles.profiles.dispatch_tester.description, /Verification executor/);
assert.match(config.agent_profiles.profiles.dispatch_tester.developer_instructions, /do not require builds for non-code work/);
assert.match(config.agent_profiles.profiles.dispatch_researcher.description, /external researcher/);
assert.match(config.agent_profiles.profiles.dispatch_researcher.developer_instructions, /does not authorize contacting others/);

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
  assert.match(promptGuidance(prompt, config), /dispatch_luna_worker/);
  assert.match(promptGuidance(prompt, config), /gpt-5\.6-luna\/max/);
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

// 通用交付、验证和外部研究必须走独立路线，设计/业务关系不触发代码图。
for (const prompt of [
  '整理访谈纪要，产出需求优先级表',
  '制作一份品牌视觉提案',
  '按已批准方案制作 UI 原型',
  'Create a report from these interview notes and deliver a priority table.',
  'Design a UI prototype for a mobile checkout flow, including the delivery address, payment method selection, validation errors, and confirmation screens',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'execution', prompt);
  assert.equal(route.needsGraph, false, prompt);
  assert.match(promptGuidance(prompt, config), /内容制作\/交付执行/, prompt);
  assert.match(promptGuidance(prompt, config), /可写执行角色/, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_planner|CodeMap Boost/, prompt);
}
for (const prompt of [
  '按已有用例验证结账流程，不修改产品',
  'Run tests to verify the fix, do not modify product code',
  '执行 QA 验收并记录结果，不修改交付物',
  '验证这个原型的导航和错误提示是否符合验收标准',
  '验证交付物是否满足验收标准',
  'Validate the deliverable against the acceptance criteria',
  'Verify totals in the worksheet against the source records',
  'Test the checkout flow against the approved acceptance criteria',
  '验证修复结果',
  'Run tests to verify the fix',
  'Verify the bug fix against the acceptance criteria',
  '运行测试计划验证原型',
  'Run the test plan against the prototype',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'verification', prompt);
  assert.equal(route.needsGraph, false, prompt);
  const guidance = promptGuidance(prompt, config);
  assert.match(guidance, /验证执行/, prompt);
  assert.match(guidance, /dispatch_tester/, prompt);
  assert.doesNotMatch(guidance, /可写执行角色|dispatch_planner/, prompt);
}
for (const prompt of [
  '制定 QA 测试计划和验收标准', 'Design a test plan',
  '编写 QA 测试计划', '撰写 QA 测试计划', '生成测试计划', '创建测试计划',
  '制作测试计划', '产出测试计划',
  'Write a test plan', 'Draft a test plan', 'Produce a test plan',
  'Create a test plan', 'Prepare a test plan',
]) {
  assert.equal(routePrompt(prompt, config).category, 'plan', prompt);
  assert.match(promptGuidance(prompt, config), /dispatch_planner/, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_tester/, prompt);
}
for (const prompt of [
  '按已有测试计划撰写结果报告',
  'Write a results report using the approved test plan',
  '撰写设计汇报材料，说明测试计划的执行结果',
  'Write a design presentation, including the test plan results',
]) {
  assert.equal(routePrompt(prompt, config).category, 'execution', prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_planner/, prompt);
}
for (const prompt of [
  '运行测试并修复失败',
  'Run tests and fix failures',
  '修复后验证',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'implementation', prompt);
  assert.match(promptGuidance(prompt, config), /常规实现/, prompt);
  assert.match(promptGuidance(prompt, config), /可写执行角色/, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_tester/, prompt);
}
for (const prompt of [
  'research competitor pricing from official sources',
  '调研官网与公开来源中的最新市场价格',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'external-research', prompt);
  assert.equal(route.needsGraph, false, prompt);
  assert.match(promptGuidance(prompt, config), /dispatch_researcher/, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_explorer|CodeMap Boost/, prompt);
}
for (const prompt of [
  'Review onboarding design for accessibility',
  '评审活动方案及渠道依赖',
  '梳理活动方案的依赖关系',
  '评审客户分类方案',
  '评审调研方法',
  '审核提交申请的流程',
  'Review the patch design for a jacket',
]) {
  assert.equal(routePrompt(prompt, config).needsGraph, false, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /CodeMap Boost|代码图|图查询/, prompt);
}
for (const prompt of [
  '审查这段代码的调用链修改',
  'Review this code patch for regressions',
  'Please inspect this patch for regressions',
  '请分析 auth 模块的依赖关系',
]) {
  assert.equal(routePrompt(prompt, config).needsGraph, true, prompt);
  assert.match(promptGuidance(prompt, config), /CodeMap Boost|图查询/, prompt);
}
const presentation = 'Prepare a design presentation for the stakeholder meeting, including customer needs, journey stages, visual direction, and the final handoff checklist.';
assert.equal(routePrompt(presentation, config).category, 'execution');
assert.match(promptGuidance(presentation, config), /内容制作\/交付执行/);
assert.doesNotMatch(promptGuidance(presentation, config), /dispatch_planner/);
const difficultReadOnly = promptGuidance('只读分析这个困难复杂的运营问题，禁止修改', config);
assert.doesNotMatch(difficultReadOnly, /可写执行角色|writer|dispatch_worker|dispatch_hard_worker/);

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
disabled.agent_profiles.profiles.dispatch_luna_worker.enabled = false;
disabled.agent_profiles.profiles.dispatch_terra_worker.enabled = false;
disabled.agent_profiles.profiles.dispatch_sol_worker.enabled = false;
disabled.agent_profiles.profiles.dispatch_astra_worker.enabled = false;
disabled.agent_profiles.profiles.dispatch_tester.enabled = false;
disabled.agent_profiles.profiles.dispatch_researcher.enabled = false;
assert.doesNotMatch(promptGuidance('请审查安全权限风险', disabled), /dispatch_deep_reviewer|dispatch_reviewer/);
assert.match(promptGuidance('请审查安全权限风险', disabled), /主代理/);
assert.doesNotMatch(promptGuidance('请扫描整个仓库的跨模块调用链', disabled), /dispatch_mapper|dispatch_explorer/);
assert.match(promptGuidance('请扫描整个仓库的跨模块调用链', disabled), /没有.*低成本|Luna max/);
assert.match(promptGuidance('请实现这个常规功能', disabled), /当前没有启用的可写执行角色，由主代理直接完成/);
assert.match(promptGuidance('按已有用例验证流程，不修改产品', disabled), /由主代理直接完成/);
assert.doesNotMatch(promptGuidance('按已有用例验证流程，不修改产品', disabled), /dispatch_tester/);
assert.match(promptGuidance('research competitor pricing from official sources', disabled), /由主代理直接完成/);
assert.doesNotMatch(promptGuidance('research competitor pricing from official sources', disabled), /dispatch_researcher/);

const unpinnedLowCost = JSON.parse(JSON.stringify(config));
unpinnedLowCost.agent_profiles.profiles.dispatch_luna_worker.model_reasoning_effort = 'medium';
assert.match(
  promptGuidance('检索最近构建日志并摘录失败原因', unpinnedLowCost),
  /dispatch_worker.*gpt-5\.6-luna\/max/
);
assert.doesNotMatch(
  promptGuidance('检索最近构建日志并摘录失败原因', unpinnedLowCost),
  /dispatch_luna_worker.*gpt-5\.6-luna\/max/
);
const noLowCost = JSON.parse(JSON.stringify(config));
noLowCost.agent_profiles.profiles.dispatch_luna_worker.enabled = false;
noLowCost.agent_profiles.profiles.dispatch_worker.model = 'gpt-5.6-sol';
noLowCost.agent_profiles.profiles.dispatch_worker.model_reasoning_effort = 'medium';
assert.match(promptGuidance('检索最近构建日志并摘录失败原因', noLowCost), /没有.*低成本/);
assert.doesNotMatch(promptGuidance('检索最近构建日志并摘录失败原因', noLowCost), /dispatch_(?:sol|terra|astra)_worker/);
noLowCost.policy.low_cost.model = 'gpt-5.5';
noLowCost.policy.low_cost.model_reasoning_effort = 'high';
const mixedNoLowCostGuidance = promptGuidance('根据构建日志修复复杂崩溃，并补回归测试', noLowCost);
assert.match(mixedNoLowCostGuidance, /没有匹配 gpt-5\.5\/high 的低成本角色/);
assert.doesNotMatch(mixedNoLowCostGuidance, /没有匹配的 Luna max/);
const lowCostDisabled = JSON.parse(JSON.stringify(config));
lowCostDisabled.policy.low_cost.enabled = false;
assert.equal(routePrompt('检索最近构建日志并摘录失败原因', lowCostDisabled).category, 'implementation');
assert.doesNotMatch(promptGuidance('检索最近构建日志并摘录失败原因', lowCostDisabled), /低成本/);

const testerOnly = JSON.parse(JSON.stringify(config));
for (const name of [
  'dispatch_worker',
  'dispatch_hard_worker',
  'dispatch_luna_worker',
  'dispatch_terra_worker',
  'dispatch_sol_worker',
  'dispatch_astra_worker',
]) {
  testerOnly.agent_profiles.profiles[name].enabled = false;
}
assert.equal(testerOnly.agent_profiles.profiles.dispatch_tester.role_kind, 'verification');
assert.match(
  promptGuidance('请实现这个常规功能', testerOnly),
  /当前没有启用的可写执行角色，由主代理直接完成/,
  'a verification specialist must not be offered as a product-code writer'
);

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
