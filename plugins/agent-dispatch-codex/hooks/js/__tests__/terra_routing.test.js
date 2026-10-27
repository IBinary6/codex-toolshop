'use strict';

const assert = require('assert').strict;
const { defaults: loadDefaults } = require('./model_fixture.cjs');
const { loadDefaults: familyDefaults, mergeConfig } = require('../lib/config');
const { resolveModelCandidates } = require('../lib/model_candidates');
const { promptGuidance, routePrompt } = require('../lib/guidance');

const config = loadDefaults();
const visualPrompts = [
  '请比对这两张截图，找出布局差异',
  '识别图纸中的尺寸和结构',
  '读取扫描件图片中的表格，提取合并单元格的位置',
  'Analyze this screenshot and identify the selected controls',
  'Compare these drawings and explain their visual differences',
  '在浏览器打开指定网页，填写表单中的给定字段',
  '操作桌面窗口，点击设置按钮并勾选选项',
  'Open the browser and navigate to the supplied page',
  'Click the desktop window button and drag the panel',
  '按已有计划操作浏览器，点击指定按钮',
  '复杂任务：分析截图并操作桌面窗口',
];
for (const prompt of visualPrompts) {
  assert.equal(routePrompt(prompt, config).category, 'visual-computer', prompt);
  const hint = promptGuidance(prompt, config);
  assert.match(hint, /dispatch_terra_worker \(gpt-6\.1-terra\/medium\)/, prompt);
  assert.match(hint, /candidate suggestion \(inferred from this message only\)/);
  assert.match(hint, /full conversation and latest explicit user instructions/);
  assert.match(hint, /do not authorize external publishing or sending, purchases or payments, production changes, or real-data changes/);
  assert.match(hint, /stronger supported model and effort/);
  assert.doesNotMatch(hint, /CodeMap Boost|Sol max/);
}

for (const prompt of ['只读分析截图，不要修改文件', 'Read-only analysis: compare these screenshots, do not modify files']) {
  const route = routePrompt(prompt, config);
  assert.equal(route.readOnly, true);
  assert.equal(route.category, 'visual-computer');
  assert.match(promptGuidance(prompt, config), /exact confirmed read-only restrictions; UI evidence gathering must stay within that scope and existing authorization/);
}
for (const prompt of ['只用主代理分析截图，不要子代理', 'Primary agent only: open the browser and click settings']) {
  assert.equal(routePrompt(prompt, config).shouldDispatch, false);
  assert.equal(promptGuidance(prompt, config), '');
}
const boundaries = [
  ['请制定浏览器操作计划和验收标准', 'plan'],
  ['Write a test plan to compare screenshots in the browser', 'plan'],
  ['审查这两张截图中的设计问题', 'review'],
  ['Review this screenshot for accessibility', 'review'],
  ['研究官方来源，比较浏览器截图工具', 'external-research'],
  ['Research official sources and compare browser screenshot tools', 'external-research'],
  ['按已有用例执行测试，比对浏览器截图', 'verification'],
  ['Run the test plan and compare screenshots', 'verification'],
  ['实现图像识别代码并读取截图', 'implementation'],
  ['修改截图处理模块并比较图像', 'implementation'],
  ['实现浏览器 MCP 集成并打开网页', 'implementation'],
  ['Write a browser automation script to click buttons', 'implementation'],
  ['Implement screenshot comparison code', 'implementation'],
  ['Implement browser MCP integration and open the browser', 'implementation'],
  ['Fix the function that extracts text from screenshots', 'implementation'],
  ['Fix browser open behavior', 'implementation'],
  ['修复浏览器打开异常', 'implementation'],
  ['提取浏览器构建日志中的错误文本', 'low-cost'],
  ['Extract errors from browser logs', 'low-cost'],
];
for (const [prompt, expected] of boundaries) {
  assert.equal(routePrompt(prompt, config).category, expected, prompt);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_terra_worker/, prompt);
}
for (const prompt of ['浏览器截图工具', 'The feature displays an image', 'MCP browser integration']) {
  assert.notEqual(routePrompt(prompt, config).category, 'visual-computer', prompt);
}
const explicit = promptGuidance('Use Sol high to compare screenshots', config);
assert.match(explicit, /Preserve explicit model choices/);
assert.match(explicit, /Do not silently replace a model explicitly requested by the user/);

for (const unavailable of [
  mergeConfig(config, { agent_profiles: { enabled: false } }),
  mergeConfig(config, { agent_profiles: { profiles: { dispatch_terra_worker: { enabled: false } } } }),
  mergeConfig(config, { agent_profiles: { profiles: { dispatch_terra_worker: { model: '' } } } }),
  mergeConfig(config, { agent_profiles: { profiles: { dispatch_terra_worker: { model_reasoning_effort: '' } } } }),
  resolveModelCandidates(familyDefaults(), null),
]) {
  const hint = promptGuidance(visualPrompts[0], unavailable);
  assert.match(hint, /No resolved, fully pinned Terra candidate/);
  assert.match(hint, /generic role with an explicit host-supported full model ID and effort/);
  assert.match(hint, /never silently inherit the parent model/);
  assert.doesNotMatch(hint, /dispatch_terra_worker \(/);
}
const pinned = mergeConfig(config, {
  agent_profiles: { profiles: { dispatch_terra_worker: { model: 'gpt-6.2-terra', model_reasoning_effort: 'high' } } },
});
assert.match(promptGuidance(visualPrompts[0], pinned), /dispatch_terra_worker \(gpt-6\.2-terra\/high\)/);
assert.match(promptGuidance('Compare screenshots, at most one subagent', config), /User limits on agent count or parallelism take precedence/);
const terra = config.agent_profiles.profiles.dispatch_terra_worker;
assert.match(terra.developer_instructions, /Honor read-only restrictions and explicit model choices/);
assert.match(terra.developer_instructions, /do not authorize external publishing or sending, purchases or payments, production changes, or real-data changes/);

for (const prompt of [
  '按已有用例在浏览器点击按钮，看截图完成UI验证，不要修改产品代码',
  'Run approved UI tests on the desktop: click controls and compare screenshots; do not modify product code',
]) {
  const route = routePrompt(prompt, config);
  assert.equal(route.category, 'visual-computer', prompt);
  assert.equal(route.visualVerification, true, prompt);
  const hint = promptGuidance(prompt, config);
  assert.match(hint, /dispatch_terra_worker/);
  assert.match(hint, /assigned established UI checks and collect observed evidence; do not modify product code or real data/);
  assert.match(hint, /Correctness review and acceptance decisions remain with the primary agent or the selected reviewer/);
}
for (const prompt of ['运行现有浏览器截图回归测试 npm test，汇总输出', 'Run existing browser screenshot tests with npm test and collect logs']) {
  assert.equal(routePrompt(prompt, config).category, 'low-cost', prompt);
  assert.match(promptGuidance(prompt, config), /dispatch_luna_worker/);
  assert.doesNotMatch(promptGuidance(prompt, config), /dispatch_terra_worker/);
}
