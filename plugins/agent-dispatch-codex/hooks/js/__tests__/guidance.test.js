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
assert.match(mainAgentGuidance(config), /keyword routes are fallible suggestions/i);
assert.match(mainAgentGuidance(config), /full conversation and the latest explicit user instructions/i);
assert.match(mainAgentGuidance(config), /no routing hint does not preserve an earlier route/i);
assert.match(mainAgentGuidance(config), /even when that work is sequential/);
assert.match(mainAgentGuidance(config), /no more than 3 subagents/);
assert.match(mainAgentGuidance(config), /dispatch_worker \(inherit, inherit\)/);
assert.match(mainAgentGuidance(config), /Choose among enabled candidates/);
assert.match(mainAgentGuidance(config), /total task cost including context, rework, review, and latency/);
assert.match(mainAgentGuidance(config), /explicitly pass model and effort/);
assert.match(mainAgentGuidance(config), /configured low-cost candidate \(gpt-6-luna\/max\)/);
assert.match(mainAgentGuidance(config), /Delegate bounded .*configured low-cost candidate \(gpt-6-luna\/max\) by default/);
assert.match(mainAgentGuidance(config), /does not implement or modify product or test code/);
assert.match(mainAgentGuidance(config), /effective gpt-6-sol\/medium candidate for code writing by default/);
assert.match(mainAgentGuidance(config), /Reserve Astra for critical review decisions/);
assert.match(mainAgentGuidance(config), /Do not escalate to max or ultra merely because a task mentions review or risk/);
assert.match(mainAgentGuidance(config), /split only the evidence stage to low-cost labor/);
assert.match(mainAgentGuidance(config), /code-evidence/);
assert.doesNotMatch(mainAgentGuidance(config), /cost-efficient execution agent/);
assert.doesNotMatch(mainAgentGuidance(config), /clear development.*Luna/);
assert.doesNotMatch(mainAgentGuidance(config), /dispatch_terra_worker/);
assert.match(mainAgentGuidance(config), /independently review non-trivial deliverables/);
assert.match(mainAgentGuidance(config), /For every new or reused review agent/);
assert.match(mainAgentGuidance(config), /autonomously choose a supported model\/effort/);
assert.match(mainAgentGuidance(config), /Keywords are routing hints, not a substitute for task judgment/);
assert.match(mainAgentGuidance(config), /observable host model\/effort metadata/);
assert.match(mainAgentGuidance(config), /task name is not evidence of the actual model/);
assert.match(mainAgentGuidance(config), /review even for small, read-only, or follow-up checks/);
assert.match(mainAgentGuidance(config), /Honor primary-only requests and disabled review delegation/);
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
assert.match(mainAgentGuidance(config, true), /ordinary Git commands serial in the primary agent/);
assert.match(mainAgentGuidance(config, true), /keyword routes are fallible suggestions/);
assert.match(mainAgentGuidance(config, true), /full conversation and the latest explicit user instructions/);
assert.match(mainAgentGuidance(config, true), /later turn with no routing hint does not preserve an earlier route/);
assert.match(mainAgentGuidance(config, true), /Complete local commit preparation/);
assert.match(mainAgentGuidance(config, true), /primary agent validates the snapshot and performs the final commit, remote operations, and history rewrites/);
assert.doesNotMatch(mainAgentGuidance(config, true), /pre_tool_nudge/);
assert.match(mainAgentGuidance(config, true), /Agent Dispatch selects the agent/);
assert.match(mainAgentGuidance(config, true), /Stop them promptly/);
assert.match(mainAgentGuidance(config, true), /independently review substantive work/);
assert.match(mainAgentGuidance(config, true), /For every new or reused review agent/);
assert.match(mainAgentGuidance(config, true), /choose a supported model/);
assert.match(mainAgentGuidance(config, true), /Reassess when scope or risk changes/);
assert.match(mainAgentGuidance(config, true), /observable host model\/effort/);
assert.match(mainAgentGuidance(config, true), /Judging correctness, compatibility, defects, or acceptance is review/);
assert.match(mainAgentGuidance(config, true), /Honor primary-only requests and disabled review delegation/);
assert.match(mainAgentGuidance(config, true), /Delegate only when independent parallel work helps/);
assert.match(mainAgentGuidance(config, true), /at most 3 concurrent subagents/);
assert.doesNotMatch(mainAgentGuidance(config, true), /must delegate in parallel/);
assert.match(mainAgentGuidance(config, true), /total cost/);
assert.match(mainAgentGuidance(config, true), /For an unpinned writer, explicitly pass model and effort/);
assert.match(mainAgentGuidance(config, true), /matching low-cost role/);
assert.match(mainAgentGuidance(config, true), /For code work/);
assert.match(mainAgentGuidance(config, true), /must not implement or modify product or test code/);
assert.match(mainAgentGuidance(config, true), /effective gpt-6-sol\/medium candidate for writing/);
assert.match(mainAgentGuidance(config, true), /Reserve Astra for critical review decisions or exceptionally complex reasoning/);
assert.match(mainAgentGuidance(config, true), /Pinned TOML values override spawn arguments/);
assert.match(mainAgentGuidance(config, true), /full-history fork cannot accept overrides/);
assert.match(mainAgentGuidance(config, true), /bounded fix by the original writer/);
assert.match(mainAgentGuidance(config, true), /Verified issues receive a bounded fix by the original writer and another review/);
assert.match(mainAgentGuidance(config, true), /Only verified defects affecting acceptance block/);
assert.match(mainAgentGuidance(config, true), /hypothetical risks and style suggestions are advisory/);
assert.match(mainAgentGuidance(config, true), /do not automatically trigger rework or a stop/);
assert.match(mainAgentGuidance(config, true), /Choose validation for the deliverable/);
assert.match(mainAgentGuidance(config, true), /do not authorize external publishing or sending, purchases, production changes, or real-data changes/);
const lowCostDisabledSession = JSON.parse(JSON.stringify(config));
lowCostDisabledSession.policy.low_cost.enabled = false;
for (const compact of [false, true]) {
  const guidance = mainAgentGuidance(lowCostDisabledSession, compact);
  assert.doesNotMatch(guidance, /configured low-cost candidate|matching low-cost role/);
  assert.match(guidance, /For code work|For code work/);
  if (compact) {
    assert.match(guidance, /For code work, first gather evidence locations/);
    assert.doesNotMatch(guidance, /low-cost labor|give the low-cost role/);
  }
}
assert.match(mainAgentGuidance(config, true), /primary agent\. Delegate/);
assert.doesNotMatch(mainAgentGuidance(config, true), /agent\.Delegate/);
const customLowCostSession = JSON.parse(JSON.stringify(config));
customLowCostSession.policy.low_cost.model = 'private-low-cost-model';
customLowCostSession.policy.low_cost.model_reasoning_effort = 'high';
assert.match(
  mainAgentGuidance(customLowCostSession),
  /configured low-cost candidate \(private-low-cost-model\/high\)/
);
assert.match(mainAgentGuidance(customLowCostSession, true), /matching low-cost role.*private-low-cost-model\/high/);
assert.doesNotMatch(mainAgentGuidance(customLowCostSession), /configured low-cost candidate \(gpt-6-luna\/max\)/);
assert.doesNotMatch(mainAgentGuidance(customLowCostSession, true), /matching low-cost role \(gpt-6-luna\/max\)/);
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
assert.match(subagentGuidance(config), /If assigned a review but the actual model\/effort differs/);
assert.match(subagentGuidance(config), /Do not claim the review passed or delegate it yourself/);

assert.equal(promptNeedsDispatch('\u8bf7\u5e2e\u6211\u5ba1\u67e5\u5e76\u8fc1\u79fb\u8fd9\u4e2a\u591a\u6587\u4ef6\u63d2\u4ef6', config), true);
assert.equal(promptNeedsDispatch('\u89e3\u91ca\u8fd9\u4e00\u884c', config), false);
assert.equal(promptGuidance('\u89e3\u91ca\u8fd9\u4e00\u884c', config), '');
assert.equal(promptGuidance('\u8fd9\u662f\u4e00\u6bb5\u9700\u8981\u4fdd\u7559\u7684\u539f\u6587\u3002'.repeat(30), config), '', 'length alone does not request delegation');
assert.equal(promptGuidance('\u5f00\u59cb\u5de5\u4f5c\u5427\u3002', config), '');

for (const prompt of [
  '\u8bf7\u5b9e\u73b0\u4ea7\u54c1\u529f\u80fd\uff1a\u9ad8\u5ea6\u503c\u7ed9\u4e2a\u9ed8\u8ba4\u503c\u5373\u53ef\uff0c\u7528\u6237\u4e0d\u4fee\u6539\u5c31\u7528\u9ed8\u8ba4\u3002',
  '\u8bf7\u5b9e\u73b0\u53ea\u8bfb\u6a21\u5f0f\u5207\u6362\uff1a\u7528\u6237\u4e0d\u542f\u7528\u53ea\u8bfb\u6a21\u5f0f\u65f6\u5141\u8bb8\u7f16\u8f91\u3002',
  '\u8bf7\u5b9e\u73b0\u6570\u636e\u4fdd\u7559\u9009\u9879\uff0c\u7528\u6237\u4e0d\u4fee\u6539\u5df2\u6709\u6570\u636e\u65f6\u4fdd\u6301\u539f\u503c\u3002',
  'Implement the editor option: when the user does not modify the value, keep the default.',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'implementation', prompt);
  assert.equal(route.readOnly, false, prompt);
  const guidance = promptGuidance(prompt, config);
  assert.match(guidance, /ordinary implementation/, prompt);
  assert.match(guidance, /candidate suggestion \(inferred from this message only\)/, prompt);
  assert.doesNotMatch(guidance, /do not perform the fix/, prompt);
}

for (const prompt of [
  '\u5148\u4e0d\u8981\u6539\u4ee3\u7801\uff0c\u53ea\u5206\u6790\u95ee\u9898\u3002',
  '\u8bf7\u53ea\u8bfb\u8bca\u65ad\u5f53\u524d\u5f02\u5e38\uff0c\u7981\u6b62\u4fee\u6539\u6587\u4ef6\u3002',
  'For now do not modify code; inspect the implementation.',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'diagnosis', prompt);
  assert.equal(route.readOnly, true, prompt);
  const guidance = promptGuidance(prompt, config);
  assert.match(guidance, /candidate suggestion \(inferred from this message only\)/, prompt);
  assert.match(guidance, /full conversation and latest explicit user instructions/, prompt);
  assert.doesNotMatch(guidance, /do not perform the fix/, prompt);
}

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
  '\u8bf7\u8ba9\u4e00\u4e2a\u53ef\u5199\u4ee3\u7406\u5b8c\u6210\u672c\u5730\u63d0\u4ea4\u51c6\u5907\u5e76\u6574\u7406\u6458\u8981',
  config
);
assert.equal(naturalLanguageCommit.category, 'execution');
assert.equal(naturalLanguageCommit.shouldDispatch, true, 'natural-language delegation remains routable');
assert.equal(routePrompt('\u67e5\u627e\u5355\u4e2a\u7b26\u53f7 Foo', config).category, 'generic');
assert.equal(routePrompt('\u67e5\u627e\u5355\u4e2a\u7b26\u53f7 Foo', config).shouldDispatch, false);
assert.equal(routePrompt('\u8bbe\u8ba1\u4e00\u4e2a\u6309\u94ae', config).shouldDispatch, false);
assert.equal(routePrompt('\u8bf7\u5b9e\u73b0\u4e00\u4e2a getter', config).shouldDispatch, false);
assert.equal(routePrompt('\u8bf7\u5148\u5236\u5b9a\u8ba1\u5212\u7136\u540e\u5b9e\u73b0\u7528\u6237\u6a21\u5757', config).category, 'plan');

for (const [prompt, kind] of [
  ['\u68c0\u7d22\u6700\u8fd1\u6784\u5efa\u65e5\u5fd7\u5e76\u6458\u5f55\u5931\u8d25\u539f\u56e0', 'logs'],
  ['\u8bfb\u53d6\u8fd9\u4e9b Markdown \u6587\u6863\uff0c\u6c47\u603b\u91cd\u590d\u6761\u76ee', 'documents'],
  ['\u5b8c\u6210\u5e38\u89c4\u6587\u6863\u8bfb\u5199\u5e76\u4fdd\u7559\u539f\u683c\u5f0f', 'documents'],
  ['\u8fd0\u884c\u73b0\u6709 CTest \u7528\u4f8b\uff0c\u6c47\u603b\u5931\u8d25\u8f93\u51fa', 'established-tests'],
  ['\u67e5\u627e\u6e90\u7801\u4e2d\u6240\u6709\u8c03\u7528\u65b9\u548c\u5f71\u54cd\u9762', 'code-evidence'],
  ['\u6309\u6a21\u677f\u6279\u91cf\u66f4\u65b0\u6587\u6863\u4e2d\u7684\u7248\u672c\u53f7', 'documents'],
  ['\u4ece CSV \u63d0\u53d6\u5b57\u6bb5\u5e76\u53bb\u91cd\u7edf\u8ba1', 'structured-data'],
  ['\u8bfb\u53d6 JSON \u6c47\u603b\u6307\u5b9a\u5b57\u6bb5', 'structured-data'],
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'low-cost', prompt);
  assert.equal(route.lowCostKind, kind, prompt);
  assert.equal(route.shouldDispatch, true, prompt);
  const guidance = promptGuidance(prompt, config);
  assert.match(guidance, /low-cost/, prompt);
  assert.match(guidance, /prefer/, prompt);
  assert.match(guidance, /gpt-6-luna\/max/, prompt);
  assert.match(guidance, /dispatch_luna_worker/, prompt);
  assert.doesNotMatch(guidance, /dispatch_(?:sol|astra)_worker/, prompt);
}
for (const [prompt, category] of [
  ['\u65b0\u589e\u5355\u5143\u6d4b\u8bd5\u7528\u4f8b\u8986\u76d6\u63a5\u53e3', 'implementation'],
  ['\u8bf7\u65b0\u589e\u590d\u6742\u5355\u5143\u6d4b\u8bd5\u7528\u4f8b', 'hard-task'],
  ['\u589e\u52a0\u56de\u5f52\u6d4b\u8bd5\u7528\u4f8b\u8986\u76d6\u63a5\u53e3', 'implementation'],
  ['\u6267\u884c\u65e2\u5b9a\u6d4b\u8bd5\u9a8c\u6536\u7ed3\u8d26\u6d41\u7a0b', 'verification'],
  ['\u8fd0\u884c\u73b0\u6709\u6d4b\u8bd5\u5e76\u6c47\u603b\u5931\u8d25', 'verification'],
  ['Write a complex implementation for a JSON parser', 'hard-task'],
  ['\u7f16\u5199\u4e00\u4e2a\u590d\u6742 JSON \u5904\u7406\u5668', 'hard-task'],
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, category, prompt);
  assert.notEqual(route.category, 'low-cost', prompt);
}
assert.equal(routePrompt('\u9a8c\u8bc1\u4ee3\u7801\u7684\u73b0\u6709\u6d4b\u8bd5', config).category, 'low-cost');
assert.equal(routePrompt('\u9a8c\u8bc1\u4ee3\u7801\u7684\u73b0\u6709\u6d4b\u8bd5', config).lowCostKind, 'established-tests');
assert.match(promptGuidance('\u6267\u884c\u65e2\u5b9a\u6d4b\u8bd5\u9a8c\u6536\u7ed3\u8d26\u6d41\u7a0b', config), /verification execution/);
assert.doesNotMatch(promptGuidance('\u6267\u884c\u65e2\u5b9a\u6d4b\u8bd5\u9a8c\u6536\u7ed3\u8d26\u6d41\u7a0b', config), /low-cost|dispatch_luna_worker/);
assert.equal(routePrompt('Run the existing test suite against the prototype', config).category, 'verification');
assert.equal(routePrompt('Run the existing test suite for the source code', config).category, 'low-cost');
assert.match(promptGuidance('\u7f16\u5199\u4e00\u4e2a\u590d\u6742 JSON \u5904\u7406\u5668', config), /difficult/);
assert.doesNotMatch(promptGuidance('\u7f16\u5199\u4e00\u4e2a\u590d\u6742 JSON \u5904\u7406\u5668', config), /low-costroutine structured-data organization/);
assert.equal(routePrompt('\u5199\u5165\u4e00\u4efd JSON \u6587\u6863', config).category, 'execution');
assert.equal(routePrompt('\u5199\u5165\u6307\u5b9a JSON \u5b57\u6bb5', config).category, 'low-cost');
assert.equal(routePrompt('\u67e5\u627e\u6e90\u7801\u4e2d\u6240\u6709\u8c03\u7528\u65b9\u548c\u5f71\u54cd\u9762', config).needsGraph, true);
const mixedEvidence = routePrompt('\u6839\u636e\u6784\u5efa\u65e5\u5fd7\u4fee\u590d\u590d\u6742\u5d29\u6e83\uff0c\u5e76\u8865\u56de\u5f52\u6d4b\u8bd5', config);
assert.equal(mixedEvidence.category, 'hard-task');
assert.equal(mixedEvidence.lowCostKind, 'logs');
assert.equal(mixedEvidence.lowCostEvidence, true);
assert.match(promptGuidance('\u6839\u636e\u6784\u5efa\u65e5\u5fd7\u4fee\u590d\u590d\u6742\u5d29\u6e83\uff0c\u5e76\u8865\u56de\u5f52\u6d4b\u8bd5', config), /assigned to.*dispatch_luna_worker/);
assert.match(promptGuidance('\u6839\u636e\u6784\u5efa\u65e5\u5fd7\u4fee\u590d\u590d\u6742\u5d29\u6e83\uff0c\u5e76\u8865\u56de\u5f52\u6d4b\u8bd5', config), /gpt-6-luna\/max/);
assert.match(promptGuidance('\u6839\u636e\u6784\u5efa\u65e5\u5fd7\u4fee\u590d\u590d\u6742\u5d29\u6e83\uff0c\u5e76\u8865\u56de\u5f52\u6d4b\u8bd5', config), /writable/);
assert.match(promptGuidance('\u6839\u636e\u6784\u5efa\u65e5\u5fd7\u4fee\u590d\u590d\u6742\u5d29\u6e83\uff0c\u5e76\u8865\u56de\u5f52\u6d4b\u8bd5', config), /dispatch_sol_worker.*gpt-6-sol\/medium/);
assert.equal(routePrompt('\u68c0\u7d22\u6784\u5efa\u65e5\u5fd7\u91cc\u7684 crash \u548c error', config).category, 'low-cost');
assert.match(promptGuidance('\u68c0\u7d22\u6784\u5efa\u65e5\u5fd7\u91cc\u7684 crash \u548c error', config), /gpt-6-luna\/max/);
assert.equal(routePrompt('\u8bf7\u4f18\u5316 Agent Dispatch\uff0c\u8ba9\u65e5\u5fd7\u8bfb\u53d6\u4ea4\u7ed9 Luna Max', config).category, 'generic');
assert.equal(promptGuidance('\u8bf7\u4f18\u5316 Agent Dispatch\uff0c\u8ba9\u65e5\u5fd7\u8bfb\u53d6\u4ea4\u7ed9 Luna Max', config), '');
assert.equal(routePrompt('\u5199\u5355\u5143\u6d4b\u8bd5\u8986\u76d6\u65b0\u7684\u63a5\u53e3\u884c\u4e3a', config).category, 'implementation');
assert.match(promptGuidance('\u5199\u5355\u5143\u6d4b\u8bd5\u8986\u76d6\u65b0\u7684\u63a5\u53e3\u884c\u4e3a', config), /ordinary implementation/);
assert.equal(routePrompt('\u5199\u5355\u5143\u6d4b\u8bd5\u8986\u76d6\u65b0\u7684\u63a5\u53e3\u884c\u4e3a', config).lowCostEvidence, false);
for (const prompt of ['\u751f\u6210\u4ee3\u7801\u5b9e\u73b0\u89e3\u6790\u5668', '\u66f4\u65b0\u6e90\u7801\u4e2d\u7684\u9519\u8bef\u5904\u7406', '\u7f16\u5199\u6d4b\u8bd5\u8986\u76d6\u8fb9\u754c\u6761\u4ef6', '\u7f16\u5199\u6d4b\u8bd5\u4ee3\u7801\u8986\u76d6\u8fb9\u754c\u6761\u4ef6']) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'implementation', prompt);
  const guidance = promptGuidance(prompt, config);
  assert.match(guidance, /dispatch_sol_worker.*gpt-6-sol\/medium/, prompt);
  assert.doesNotMatch(guidance, /dispatch_luna_worker/, prompt);
}
for (const prompt of ['\u751f\u6210\u4f1a\u8bae\u6458\u8981', '\u6574\u7406\u73b0\u6709\u6587\u6863', '\u5199\u4e00\u4efd\u53d1\u5e03\u8bf4\u660e']) {
  assert.notEqual(routePrompt(prompt, config).category, 'implementation', prompt);
}
const readOnlyDocuments = promptGuidance('\u53ea\u8bfb\u8bfb\u53d6 Markdown \u6587\u6863\u5e76\u6c47\u603b\u91cd\u590d\u6761\u76ee\uff0c\u4e0d\u4fee\u6539\u6587\u4ef6', config);
assert.match(readOnlyDocuments, /confirmed read-only scope/);
assert.doesNotMatch(readOnlyDocuments, /may edit only/);
assert.equal(routePrompt('\u53ea\u7528\u4e3b\u4ee3\u7406\u68c0\u7d22\u6784\u5efa\u65e5\u5fd7\uff0c\u4e0d\u8981\u5b50\u4ee3\u7406', config).category, 'primary-only');
assert.equal(promptGuidance('\u53ea\u7528\u4e3b\u4ee3\u7406\u68c0\u7d22\u6784\u5efa\u65e5\u5fd7\uff0c\u4e0d\u8981\u5b50\u4ee3\u7406', config), '');
assert.equal(routePrompt('\u8bf7\u8ba8\u8bba\u4f4e\u6210\u672c\u6a21\u578b\u914d\u7f6e\uff0c\u4e0d\u6267\u884c\u4efb\u52a1', config).category, 'generic');

const highRisk = promptGuidance('\u8bf7\u5ba1\u67e5\u5b89\u5168\u6743\u9650\u548c\u751f\u4ea7\u5e76\u53d1\u98ce\u9669', config);
assert.match(highRisk, /high-risk review/);
assert.match(highRisk, /dispatch_deep_reviewer/);
assert.doesNotMatch(highRisk, /dispatch_worker/);
assert.match(promptGuidance('\u8bf7\u67e5\u627e\u8fd9\u4e2a\u6587\u4ef6\u5e76\u5ba1\u67e5\u5b89\u5168\u6f0f\u6d1e', config), /dispatch_deep_reviewer/);

const hard = promptGuidance('\u8bf7\u5b9e\u73b0\u4e00\u4e2a\u56f0\u96be\u4e14\u590d\u6742\u7684\u529f\u80fd\uff0c\u5e76\u6392\u67e5\u590d\u6742\u8c03\u8bd5\u95ee\u9898', config);
assert.match(hard, /writable/);
assert.match(hard, /dispatch_sol_worker.*gpt-6-sol\/medium/);
assert.match(hard, /primary agent.*accept/);
assert.doesNotMatch(hard, /dispatch_luna_worker/);

const plannedHard = promptGuidance('\u8bf7\u5148\u5236\u5b9a\u8de8\u6a21\u5757\u67b6\u6784\u8ba1\u5212\uff0c\u7136\u540e\u5b9e\u73b0\u56f0\u96be\u7684\u590d\u6742\u8c03\u8bd5\u4efb\u52a1', config);
assert.match(plannedHard, /dispatch_planner/);
assert.match(plannedHard, /writable/);
assert.match(plannedHard, /model and effort/);
assert.match(plannedHard, /without replanning/);
assert.doesNotMatch(plannedHard, /must use two serial phases|must spawn/);
assert.match(plannedHard, /dispatch_sol_worker.*gpt-6-sol\/medium/);
assert.doesNotMatch(plannedHard, /dispatch_luna_worker/);

assert.match(promptGuidance('\u8bf7\u8bbe\u8ba1\u65b0\u7684\u67b6\u6784\u548c\u63a5\u53e3\u65b9\u6848', config), /dispatch_planner/);
assert.match(promptGuidance('\u8bf7\u8bbe\u8ba1\u65b0\u7684\u67b6\u6784\u548c\u63a5\u53e3\u65b9\u6848', config), /gpt-6-sol\/high/);
assert.match(promptGuidance('\u8bf7\u626b\u63cf\u6574\u4e2a\u4ed3\u5e93\u7684\u8de8\u6a21\u5757\u8c03\u7528\u94fe', config), /dispatch_luna_worker/);
assert.match(promptGuidance('\u8bf7\u626b\u63cf\u6574\u4e2a\u4ed3\u5e93\u7684\u8de8\u6a21\u5757\u8c03\u7528\u94fe', config), /gpt-6-luna\/max/);
assert.match(promptGuidance('\u8bf7\u626b\u63cf\u6574\u4e2a\u4ed3\u5e93\u7684\u8de8\u6a21\u5757\u8c03\u7528\u94fe', config), /CodeMap Boost owns graph refresh/);
assert.match(promptGuidance('\u8bf7\u641c\u7d22\u591a\u4e2a\u6587\u4ef6\u4e2d\u7684\u8c03\u7528\u94fe\u548c\u5f71\u54cd\u9762', config), /dispatch_luna_worker/);
assert.match(promptGuidance('\u8bf7\u641c\u7d22\u591a\u4e2a\u6587\u4ef6\u4e2d\u7684\u8c03\u7528\u94fe\u548c\u5f71\u54cd\u9762', config), /gpt-6-luna\/max/);
assert.match(promptGuidance('\u8bf7\u641c\u7d22\u591a\u4e2a\u6587\u4ef6\u4e2d\u7684\u8c03\u7528\u94fe\u548c\u5f71\u54cd\u9762', config), /do not repeat build\/update/);
const implementation = promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', config);
assert.match(implementation, /writable/);
assert.match(implementation, /model and effort/);
assert.match(promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', config), /primary agent.*accept/);
assert.match(implementation, /dispatch_sol_worker.*gpt-6-sol\/medium/);
assert.doesNotMatch(implementation, /dispatch_luna_worker/);
assert.match(implementation, /After proportionate validation, independently review substantive work/);
assert.match(implementation, /bounded fix by the original writer/);
assert.match(implementation, /concrete issues affecting acceptance/);
assert.match(implementation, /after verification by the primary agent/);
assert.match(implementation, /advisory notes do not automatically trigger rework or a stop/);
assert.doesNotMatch(implementation, /dispatch_reviewer|dispatch_deep_reviewer/);
assert.match(implementation, /For every new or reused review agent/);
assert.match(implementation, /Evidence collection and established test results do not by themselves constitute an independent review/);
assert.match(promptGuidance('\u8bf7\u5ba1\u67e5\u8fd9\u6bb5\u4ee3\u7801\u7684\u6b63\u786e\u6027', config), /dispatch_reviewer/);
assert.match(promptGuidance('review this code for correctness', config), /dispatch_reviewer/);
assert.match(promptGuidance('\u8bf7\u5ba1\u67e5\u8fd9\u6bb5\u4ee3\u7801\u7684\u6b63\u786e\u6027', config), /gpt-6-sol\/high/);
assert.doesNotMatch(promptGuidance('\u8bf7\u5ba1\u67e5\u8fd9\u6bb5\u4ee3\u7801\u7684\u6b63\u786e\u6027', config), /dispatch_deep_reviewer/);
assert.match(promptGuidance('\u8bf7\u5ba1\u67e5\u5b89\u5168\u6743\u9650\u98ce\u9669', config), /risk keywords alone do not require escalation/);

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
  'dispatch_sol_worker',
  'dispatch_astra_worker',
]) {
  const profile = config.agent_profiles.profiles[name];
  assert.match(profile.description, /deliverable/i, name);
  assert.match(profile.developer_instructions, /does not authorize external publishing or sending/i, name);
  assert.match(profile.developer_instructions, /(?:validation evidence appropriate to (?:that |the )?deliverable|validate the deliverable .* appropriate evidence)/i, name);
}
const lunaLabor = config.agent_profiles.profiles.dispatch_luna_worker;
assert.equal(lunaLabor.role_kind, 'labor');
assert.match(lunaLabor.description, /search, source and log evidence/i);
assert.match(lunaLabor.developer_instructions, /must not implement or modify product or test code/i);
assert.match(lunaLabor.developer_instructions, /executed checks, changed evidence files, and blockers/i);
assert.match(lunaLabor.developer_instructions, /does not authorize external publishing or sending/i);
assert.match(config.agent_profiles.profiles.dispatch_tester.description, /Verification executor/);
assert.match(config.agent_profiles.profiles.dispatch_tester.developer_instructions, /do not require builds for non-code work/);
assert.match(config.agent_profiles.profiles.dispatch_researcher.description, /external researcher/);
assert.match(config.agent_profiles.profiles.dispatch_researcher.developer_instructions, /does not authorize contacting others/);

// Task scope must affect routing, not merely appear as a static promise to respect the user.
for (const prompt of ['\u53ea\u8bfb\u8bca\u65ad\u8fd9\u6b21\u5d29\u6e83\u7684\u6839\u56e0\uff0c\u7981\u6b62\u4fee\u6539\u6587\u4ef6\u3002', 'Diagnose the root cause of this crash, read-only.']) {
  const hint = promptGuidance(prompt, config);
  assert.match(hint, /read-only diagnosis/);
  assert.doesNotMatch(hint, /writable|dispatch_planner|implementation complete/);
}
for (const prompt of ['\u53ea\u7528\u4e3b\u4ee3\u7406\u4fee\u590d\u590d\u6742\u5d29\u6e83\uff0c\u4e0d\u8981\u5b50\u4ee3\u7406\u3002', '\u6309\u5df2\u6709\u8ba1\u5212\u8fc1\u79fb\u8de8\u6a21\u5757\u63a5\u53e3\uff0c\u4e0d\u8981\u59d4\u6d3e\u3002', 'Main agent only: review this security patch.']) {
  assert.equal(routePrompt(prompt, config).shouldDispatch, false, prompt);
  assert.equal(promptGuidance(prompt, config), '', prompt);
}
const existingPlan = promptGuidance('\u6309\u5df2\u6709\u8ba1\u5212\u5b9e\u73b0\u8de8\u6a21\u5757\u63a5\u53e3\u8fc1\u79fb\uff0c\u4e0d\u8981\u91cd\u65b0\u89c4\u5212\u3002', config);
assert.match(existingPlan, /ordinary implementation/);
assert.match(existingPlan, /prefer graph queries/);
assert.doesNotMatch(existingPlan, /dispatch_planner|substantive plan/);
for (const prompt of [
  '\u6309\u5df2\u6709\u5b9e\u73b0\u8ba1\u5212\u5b9e\u73b0\u8de8\u6a21\u5757\u8fc1\u79fb',
  '\u5df2\u6709\u5b9e\u73b0\u65b9\u6848\uff0c\u7ee7\u7eed\u5b9e\u73b0\u8de8\u6a21\u5757\u8fc1\u79fb',
  '\u6309\u5df2\u6709\u6267\u884c\u8ba1\u5212\u5b9e\u73b0\u8de8\u6a21\u5757\u8fc1\u79fb',
  '\u5df2\u6709\u6267\u884c\u65b9\u6848\uff0c\u7ee7\u7eed\u5b9e\u73b0\u8de8\u6a21\u5757\u8fc1\u79fb',
  '\u6309\u73b0\u6709\u5b9e\u73b0\u8ba1\u5212\u5b9e\u73b0\u8de8\u6a21\u5757\u8fc1\u79fb',
  '\u73b0\u6709\u5b9e\u73b0\u65b9\u6848\uff0c\u7ee7\u7eed\u5b9e\u73b0\u8de8\u6a21\u5757\u8fc1\u79fb',
  '\u6309\u73b0\u6709\u6267\u884c\u8ba1\u5212\u5b9e\u73b0\u8de8\u6a21\u5757\u8fc1\u79fb',
  '\u73b0\u6709\u6267\u884c\u65b9\u6848\uff0c\u7ee7\u7eed\u5b9e\u73b0\u8de8\u6a21\u5757\u8fc1\u79fb',
  'Implement the cross-module migration using the existing implementation plan.',
  'Implement the cross-module migration using the existing execution plan.',
  'Implement the cross-module migration using the approved implementation plan.',
  'Implement the cross-module migration using the approved execution plan.',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.existingPlan, true, prompt);
  assert.equal(route.category, 'implementation', prompt);
  assert.match(promptGuidance(prompt, config), /ordinary implementation/, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_planner|substantive plan/, prompt);
}
for (const prompt of [
  '\u8fd8\u6ca1\u6709\u5b9e\u73b0\u8ba1\u5212\uff0c\u8bf7\u89c4\u5212\u8de8\u6a21\u5757\u8fc1\u79fb',
  '\u8bf7\u5236\u5b9a\u5b9e\u73b0\u8ba1\u5212\uff0c\u7136\u540e\u5b9e\u73b0\u8de8\u6a21\u5757\u8fc1\u79fb',
  '\u8bf7\u5236\u5b9a\u6267\u884c\u65b9\u6848\uff0c\u7136\u540e\u5b9e\u73b0\u8de8\u6a21\u5757\u8fc1\u79fb',
  'Create an implementation plan for the cross-module migration.',
  'Create an execution plan for the cross-module migration.',
]) {
  assert.equal(routePrompt(prompt, config).existingPlan, false, prompt);
  assert.equal(routePrompt(prompt, config).category, 'plan', prompt);
  assert.match(promptGuidance(prompt, config), /dispatch_planner/, prompt);
}
for (const prompt of [
  '\u6309\u5df2\u6709\u5b9e\u73b0\u8ba1\u5212\u53ea\u8bfb\u5206\u6790\u8de8\u6a21\u5757\u8fc1\u79fb\uff0c\u7981\u6b62\u4fee\u6539\u6587\u4ef6',
  'Inspect the cross-module migration using the approved execution plan, read-only.',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.existingPlan, true, prompt);
  assert.equal(route.category, 'broad-search', prompt);
  assert.equal(route.readOnly, true, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /writable|dispatch_planner/, prompt);
}
for (const prompt of [
  '\u53ea\u7528\u4e3b\u4ee3\u7406\uff0c\u6309\u73b0\u6709\u6267\u884c\u65b9\u6848\u5b9e\u73b0\u8de8\u6a21\u5757\u8fc1\u79fb',
  'Main agent only: implement the cross-module migration using the existing implementation plan.',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.existingPlan, true, prompt);
  assert.equal(route.category, 'primary-only', prompt);
  assert.equal(route.shouldDispatch, false, prompt);
  assert.equal(promptGuidance(prompt, config), '', prompt);
}
for (const prompt of ['What depends on the auth module?', 'Find all callers of authService.', '\u8bf7\u5206\u6790 auth \u6a21\u5757\u7684\u4f9d\u8d56\u5173\u7cfb']) {
  assert.match(promptGuidance(prompt, config), /dispatch_luna_worker/);
  assert.match(promptGuidance(prompt, config), /gpt-6-luna\/max/);
  assert.match(promptGuidance(prompt, config), /prefer graph queries/);
}
for (const prompt of ['Please inspect this patch for regressions.', 'Please check this change for regressions.', '\u5ba1\u67e5\u8de8\u6a21\u5757\u8c03\u7528\u94fe\u4fee\u6539']) {
  assert.match(promptGuidance(prompt, config), /dispatch_reviewer/);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_mapper/);
}
for (const prompt of ['Review the spelling of the word security in README only.', 'Review the production deployment wording in docs only.', 'Review the security wording in CHANGELOG only.']) {
  assert.equal(promptGuidance(prompt, config), '', prompt);
}
const narrowRisk = promptGuidance('Fix this permission bug in one file.', config);
assert.match(narrowRisk, /primary agent/);
assert.match(narrowRisk, /contract|evidence/);
assert.doesNotMatch(narrowRisk, /read-only|writable|dispatch_/);
assert.equal(promptGuidance('\u53ea\u8bfb\u68c0\u67e5\u4e00\u4e2a\u6587\u4ef6\u91cc\u7684\u5d29\u6e83\u539f\u56e0\uff0c\u4e0d\u4fee\u6539', config), '');
assert.doesNotMatch(promptGuidance('Explain the current architecture.', config), /dispatch_planner/);
assert.match(promptGuidance('Fix this permission bug across modules.', config), /existing authorization|existing authorization/);
assert.match(promptGuidance('Use only one agent to fix this complex crash.', config), /User limits on agent count or parallelism take precedence/);

// General deliverables, verification, and external research use distinct routes; design and business relationships do not trigger code graphs.
for (const prompt of [
  '\u6574\u7406\u8bbf\u8c08\u7eaa\u8981\uff0c\u4ea7\u51fa\u9700\u6c42\u4f18\u5148\u7ea7\u8868',
  '\u5236\u4f5c\u4e00\u4efd\u54c1\u724c\u89c6\u89c9\u63d0\u6848',
  '\u6309\u5df2\u6279\u51c6\u65b9\u6848\u5236\u4f5c UI \u539f\u578b',
  'Create a report from these interview notes and deliver a priority table.',
  'Design a UI prototype for a mobile checkout flow, including the delivery address, payment method selection, validation errors, and confirmation screens',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'execution', prompt);
  assert.equal(route.needsGraph, false, prompt);
  assert.match(promptGuidance(prompt, config), /content production or deliverable execution/, prompt);
  assert.match(promptGuidance(prompt, config), /writable/, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_planner|CodeMap Boost/, prompt);
}
for (const prompt of [
  '\u6309\u5df2\u6709\u7528\u4f8b\u9a8c\u8bc1\u7ed3\u8d26\u6d41\u7a0b\uff0c\u4e0d\u4fee\u6539\u4ea7\u54c1',
  'Run tests to verify the fix, do not modify product code',
  '\u6267\u884c QA \u9a8c\u6536\u5e76\u8bb0\u5f55\u7ed3\u679c\uff0c\u4e0d\u4fee\u6539\u4ea4\u4ed8\u7269',
  '\u9a8c\u8bc1\u8fd9\u4e2a\u539f\u578b\u7684\u5bfc\u822a\u548c\u9519\u8bef\u63d0\u793a\u662f\u5426\u7b26\u5408\u9a8c\u6536\u6807\u51c6',
  '\u9a8c\u8bc1\u4ea4\u4ed8\u7269\u662f\u5426\u6ee1\u8db3\u9a8c\u6536\u6807\u51c6',
  'Validate the deliverable against the acceptance criteria',
  'Verify totals in the worksheet against the source records',
  'Test the checkout flow against the approved acceptance criteria',
  '\u9a8c\u8bc1\u4fee\u590d\u7ed3\u679c',
  'Run tests to verify the fix',
  'Verify the bug fix against the acceptance criteria',
  '\u8fd0\u884c\u6d4b\u8bd5\u8ba1\u5212\u9a8c\u8bc1\u539f\u578b',
  'Run the test plan against the prototype',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'verification', prompt);
  assert.equal(route.needsGraph, false, prompt);
  const guidance = promptGuidance(prompt, config);
  assert.match(guidance, /verification execution/, prompt);
  assert.match(guidance, /dispatch_tester/, prompt);
  assert.doesNotMatch(guidance, /writable|dispatch_planner/, prompt);
}
for (const prompt of [
  '\u5236\u5b9a QA \u6d4b\u8bd5\u8ba1\u5212\u548c\u9a8c\u6536\u6807\u51c6', 'Design a test plan',
  '\u7f16\u5199 QA \u6d4b\u8bd5\u8ba1\u5212', '\u64b0\u5199 QA \u6d4b\u8bd5\u8ba1\u5212', '\u751f\u6210\u6d4b\u8bd5\u8ba1\u5212', '\u521b\u5efa\u6d4b\u8bd5\u8ba1\u5212',
  '\u5236\u4f5c\u6d4b\u8bd5\u8ba1\u5212', '\u4ea7\u51fa\u6d4b\u8bd5\u8ba1\u5212',
  'Write a test plan', 'Draft a test plan', 'Produce a test plan',
  'Create a test plan', 'Prepare a test plan',
]) {
  assert.equal(routePrompt(prompt, config).category, 'plan', prompt);
  assert.match(promptGuidance(prompt, config), /dispatch_planner/, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_tester/, prompt);
}
for (const prompt of [
  '\u6309\u5df2\u6709\u6d4b\u8bd5\u8ba1\u5212\u64b0\u5199\u7ed3\u679c\u62a5\u544a',
  'Write a results report using the approved test plan',
  '\u64b0\u5199\u8bbe\u8ba1\u6c47\u62a5\u6750\u6599\uff0c\u8bf4\u660e\u6d4b\u8bd5\u8ba1\u5212\u7684\u6267\u884c\u7ed3\u679c',
  'Write a design presentation, including the test plan results',
]) {
  assert.equal(routePrompt(prompt, config).category, 'execution', prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_planner/, prompt);
}
for (const prompt of [
  '\u8fd0\u884c\u6d4b\u8bd5\u5e76\u4fee\u590d\u5931\u8d25',
  'Run tests and fix failures',
  '\u4fee\u590d\u540e\u9a8c\u8bc1',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'implementation', prompt);
  assert.match(promptGuidance(prompt, config), /ordinary implementation/, prompt);
  assert.match(promptGuidance(prompt, config), /writable/, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_tester/, prompt);
}
for (const prompt of [
  'research competitor pricing from official sources',
  '\u8c03\u7814\u5b98\u7f51\u4e0e\u516c\u5f00\u6765\u6e90\u4e2d\u7684\u6700\u65b0\u5e02\u573a\u4ef7\u683c',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'external-research', prompt);
  assert.equal(route.needsGraph, false, prompt);
  assert.match(promptGuidance(prompt, config), /dispatch_researcher/, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_explorer|CodeMap Boost/, prompt);
}
for (const prompt of [
  'Review onboarding design for accessibility',
  '\u8bc4\u5ba1\u6d3b\u52a8\u65b9\u6848\u53ca\u6e20\u9053\u4f9d\u8d56',
  '\u68b3\u7406\u6d3b\u52a8\u65b9\u6848\u7684\u4f9d\u8d56\u5173\u7cfb',
  '\u8bc4\u5ba1\u5ba2\u6237\u5206\u7c7b\u65b9\u6848',
  '\u8bc4\u5ba1\u8c03\u7814\u65b9\u6cd5',
  '\u5ba1\u6838\u63d0\u4ea4\u7533\u8bf7\u7684\u6d41\u7a0b',
  'Review the patch design for a jacket',
]) {
  assert.equal(routePrompt(prompt, config).needsGraph, false, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /CodeMap Boost|code graph|graph quer/, prompt);
}
for (const prompt of [
  '\u5ba1\u67e5\u8fd9\u6bb5\u4ee3\u7801\u7684\u8c03\u7528\u94fe\u4fee\u6539',
  'Review this code patch for regressions',
  'Please inspect this patch for regressions',
  '\u8bf7\u5206\u6790 auth \u6a21\u5757\u7684\u4f9d\u8d56\u5173\u7cfb',
]) {
  assert.equal(routePrompt(prompt, config).needsGraph, true, prompt);
  assert.match(promptGuidance(prompt, config), /CodeMap Boost|graph quer/, prompt);
}
const presentation = 'Prepare a design presentation for the stakeholder meeting, including customer needs, journey stages, visual direction, and the final handoff checklist.';
assert.equal(routePrompt(presentation, config).category, 'execution');
assert.match(promptGuidance(presentation, config), /content production or deliverable execution/);
assert.doesNotMatch(promptGuidance(presentation, config), /dispatch_planner/);
const difficultReadOnly = promptGuidance('\u53ea\u8bfb\u5206\u6790\u8fd9\u4e2a\u56f0\u96be\u590d\u6742\u7684\u8fd0\u8425\u95ee\u9898\uff0c\u7981\u6b62\u4fee\u6539', config);
assert.doesNotMatch(difficultReadOnly, /writable|writer|dispatch_worker|dispatch_hard_worker/);

const overridden = JSON.parse(JSON.stringify(config));
overridden.agent_profiles.profiles.dispatch_reviewer.model = 'gpt-6-astra';
overridden.agent_profiles.profiles.dispatch_reviewer.model_reasoning_effort = 'low';
assert.match(promptGuidance('review this code for correctness', overridden), /gpt-6-astra\/low/);
for (const compact of [false, true]) {
  const guidance = mainAgentGuidance(overridden, compact);
  assert.match(guidance, /dispatch_reviewer \(gpt-6-astra, low\)/);
  assert.doesNotMatch(guidance, /Sol xhigh/, 'fixed role recommendations must not override profile settings');
}
for (const prompt of ['\u8bf7\u8bbe\u8ba1\u65b0\u7684\u67b6\u6784\u548c\u63a5\u53e3\u65b9\u6848', '\u8bf7\u5ba1\u67e5\u8fd9\u6bb5\u4ee3\u7801\u7684\u6b63\u786e\u6027', '\u8bf7\u641c\u7d22\u591a\u4e2a\u6587\u4ef6\u4e2d\u7684\u8c03\u7528\u94fe']) {
  const guidance = promptGuidance(prompt, config);
  assert.doesNotMatch(guidance, /must spawn|\u5fc5\u987b\u59d4\u6d3e/);
  assert.match(guidance, /user preferences/);
  assert.match(guidance, /host model\/effort support/);
}

const disabled = JSON.parse(JSON.stringify(config));
disabled.agent_profiles.profiles.dispatch_deep_reviewer.enabled = false;
disabled.agent_profiles.profiles.dispatch_reviewer.enabled = false;
disabled.agent_profiles.profiles.dispatch_mapper.enabled = false;
disabled.agent_profiles.profiles.dispatch_worker.enabled = false;
disabled.agent_profiles.profiles.dispatch_hard_worker.enabled = false;
disabled.agent_profiles.profiles.dispatch_luna_worker.enabled = false;
disabled.agent_profiles.profiles.dispatch_sol_worker.enabled = false;
disabled.agent_profiles.profiles.dispatch_astra_worker.enabled = false;
disabled.agent_profiles.profiles.dispatch_tester.enabled = false;
disabled.agent_profiles.profiles.dispatch_researcher.enabled = false;
assert.doesNotMatch(promptGuidance('\u8bf7\u5ba1\u67e5\u5b89\u5168\u6743\u9650\u98ce\u9669', disabled), /dispatch_deep_reviewer|dispatch_reviewer/);
assert.match(promptGuidance('\u8bf7\u5ba1\u67e5\u5b89\u5168\u6743\u9650\u98ce\u9669', disabled), /primary agent/);
assert.doesNotMatch(promptGuidance('\u8bf7\u626b\u63cf\u6574\u4e2a\u4ed3\u5e93\u7684\u8de8\u6a21\u5757\u8c03\u7528\u94fe', disabled), /dispatch_mapper|dispatch_explorer/);
assert.match(promptGuidance('\u8bf7\u626b\u63cf\u6574\u4e2a\u4ed3\u5e93\u7684\u8de8\u6a21\u5757\u8c03\u7528\u94fe', disabled), /no.*low-cost|Luna max/);
assert.match(promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', disabled), /No code implementation candidate matches the effective gpt-6-sol\/medium pair. The primary agent handles the work/);
assert.match(promptGuidance('\u6309\u5df2\u6709\u7528\u4f8b\u9a8c\u8bc1\u6d41\u7a0b\uff0c\u4e0d\u4fee\u6539\u4ea7\u54c1', disabled), /primary agent handles/);
assert.doesNotMatch(promptGuidance('\u6309\u5df2\u6709\u7528\u4f8b\u9a8c\u8bc1\u6d41\u7a0b\uff0c\u4e0d\u4fee\u6539\u4ea7\u54c1', disabled), /dispatch_tester/);
assert.match(promptGuidance('research competitor pricing from official sources', disabled), /primary agent handles/);
assert.doesNotMatch(promptGuidance('research competitor pricing from official sources', disabled), /dispatch_researcher/);

const unpinnedLowCost = JSON.parse(JSON.stringify(config));
unpinnedLowCost.agent_profiles.profiles.dispatch_luna_worker.model_reasoning_effort = 'medium';
assert.match(
  promptGuidance('\u68c0\u7d22\u6700\u8fd1\u6784\u5efa\u65e5\u5fd7\u5e76\u6458\u5f55\u5931\u8d25\u539f\u56e0', unpinnedLowCost),
  /dispatch_worker.*gpt-6-luna\/max/
);
assert.doesNotMatch(
  promptGuidance('\u68c0\u7d22\u6700\u8fd1\u6784\u5efa\u65e5\u5fd7\u5e76\u6458\u5f55\u5931\u8d25\u539f\u56e0', unpinnedLowCost),
  /dispatch_luna_worker.*gpt-6-luna\/max/
);
const solDisabled = JSON.parse(JSON.stringify(config));
solDisabled.agent_profiles.profiles.dispatch_sol_worker.enabled = false;
assert.match(
  promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', solDisabled),
  /dispatch_worker.*explicit gpt-6-sol\/medium/
);
assert.doesNotMatch(promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', solDisabled), /dispatch_sol_worker/);
const solOverridden = JSON.parse(JSON.stringify(config));
solOverridden.agent_profiles.profiles.dispatch_sol_worker.model = 'gpt-6-astra';
solOverridden.agent_profiles.profiles.dispatch_sol_worker.model_reasoning_effort = 'high';
assert.match(
  promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', solOverridden),
  /dispatch_sol_worker.*gpt-6-astra\/high/
);
assert.doesNotMatch(promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', solOverridden), /explicit gpt-6-sol\/medium/);
const fixedLunaGeneric = JSON.parse(JSON.stringify(config));
fixedLunaGeneric.agent_profiles.profiles.dispatch_sol_worker.enabled = false;
fixedLunaGeneric.agent_profiles.profiles.dispatch_worker.model = 'gpt-6-luna';
fixedLunaGeneric.agent_profiles.profiles.dispatch_worker.model_reasoning_effort = 'max';
fixedLunaGeneric.agent_profiles.profiles.dispatch_hard_worker.enabled = false;
assert.match(promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', fixedLunaGeneric), /primary agent handles/);
assert.doesNotMatch(promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', fixedLunaGeneric), /dispatch_worker|dispatch_luna_worker/);
fixedLunaGeneric.agent_profiles.profiles.dispatch_worker.model = 'gpt-future-luna';
assert.doesNotMatch(promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', fixedLunaGeneric), /dispatch_worker|dispatch_luna_worker/);
const noLowCost = JSON.parse(JSON.stringify(config));
noLowCost.agent_profiles.profiles.dispatch_luna_worker.enabled = false;
noLowCost.agent_profiles.profiles.dispatch_worker.model = 'gpt-6-sol';
noLowCost.agent_profiles.profiles.dispatch_worker.model_reasoning_effort = 'medium';
assert.match(promptGuidance('\u68c0\u7d22\u6700\u8fd1\u6784\u5efa\u65e5\u5fd7\u5e76\u6458\u5f55\u5931\u8d25\u539f\u56e0', noLowCost), /no.*low-cost/);
assert.doesNotMatch(promptGuidance('\u68c0\u7d22\u6700\u8fd1\u6784\u5efa\u65e5\u5fd7\u5e76\u6458\u5f55\u5931\u8d25\u539f\u56e0', noLowCost), /dispatch_(?:sol|astra)_worker/);
noLowCost.policy.low_cost.model = 'private-low-cost-model';
noLowCost.policy.low_cost.model_reasoning_effort = 'high';
const mixedNoLowCostGuidance = promptGuidance('\u6839\u636e\u6784\u5efa\u65e5\u5fd7\u4fee\u590d\u590d\u6742\u5d29\u6e83\uff0c\u5e76\u8865\u56de\u5f52\u6d4b\u8bd5', noLowCost);
assert.match(mixedNoLowCostGuidance, /no low-cost role matches private-low-cost-model\/high/);
assert.doesNotMatch(mixedNoLowCostGuidance, /no matching Luna max/);
const lowCostDisabled = JSON.parse(JSON.stringify(config));
lowCostDisabled.policy.low_cost.enabled = false;
assert.equal(routePrompt('\u68c0\u7d22\u6700\u8fd1\u6784\u5efa\u65e5\u5fd7\u5e76\u6458\u5f55\u5931\u8d25\u539f\u56e0', lowCostDisabled).category, 'implementation');
assert.doesNotMatch(promptGuidance('\u68c0\u7d22\u6700\u8fd1\u6784\u5efa\u65e5\u5fd7\u5e76\u6458\u5f55\u5931\u8d25\u539f\u56e0', lowCostDisabled), /Task route: low-cost|dispatch_luna_worker/);

const testerOnly = JSON.parse(JSON.stringify(config));
for (const name of [
  'dispatch_worker',
  'dispatch_hard_worker',
  'dispatch_luna_worker',
  'dispatch_sol_worker',
  'dispatch_astra_worker',
]) {
  testerOnly.agent_profiles.profiles[name].enabled = false;
}
assert.equal(testerOnly.agent_profiles.profiles.dispatch_tester.role_kind, 'verification');
assert.match(
  promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', testerOnly),
  /No code implementation candidate matches the effective gpt-6-sol\/medium pair. The primary agent handles the work/,
  'a verification specialist must not be offered as a product-code writer'
);
const laborAndTesterOnly = JSON.parse(JSON.stringify(config));
for (const name of [
  'dispatch_worker',
  'dispatch_hard_worker',
  'dispatch_sol_worker',
  'dispatch_astra_worker',
]) {
  laborAndTesterOnly.agent_profiles.profiles[name].enabled = false;
}
assert.equal(laborAndTesterOnly.agent_profiles.profiles.dispatch_luna_worker.role_kind, 'labor');
assert.match(
  promptGuidance('\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd', laborAndTesterOnly),
  /No code implementation candidate matches the effective gpt-6-sol\/medium pair. The primary agent handles the work/,
  'labor and verification profiles must not be offered as code writers'
);

assert.equal(toolNudge({ tool_name: 'apply_patch', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__code_review_graph__get_minimal_context_tool', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__context-mode__ctx_execute', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__plugin_context-mode_context-mode__ctx_search', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__serena__find_symbol', tool_input: {} }, config), '');
assert.equal(toolNudge({ tool_name: 'mcp__serena-cross-platform__find_symbol', tool_input: {} }, config), '');
assert.match(toolNudge({ tool_name: 'mcp__heavy_remote__scan', tool_input: {} }, config), /tool name alone does not require it/);
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git status' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git branch -D temp' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git push origin --delete temp' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'git log > out.txt' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: 'reg query HKCU\\Software\\AgentDispatch' } }, config), '');
assert.equal(toolNudge({ tool_name: 'Bash', tool_input: { command: "bash -lc 'reg query HKCU\\Software\\AgentDispatch'" } }, config), '');
assert.match(toolNudge({ tool_name: 'Bash', tool_input: { command: 'reg add HKCU\\Software\\AgentDispatch /v Enabled /t REG_DWORD /d 1 /f' } }, config), /registry write/);
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
