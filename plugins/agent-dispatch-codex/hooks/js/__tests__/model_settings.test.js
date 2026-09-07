'use strict';

const assert = require('assert').strict;
const { loadDefaults, mergeConfig, modelEffortWarnings } = require('../lib/config');
const { renderAgentProfile } = require('../lib/agent_profiles');
const { mainAgentGuidance } = require('../lib/guidance');

const baseline = loadDefaults();
assert.equal(Object.keys(baseline.agent_profiles.profiles).length, 13);
assert.deepEqual(modelEffortWarnings(baseline), []);
for (const profile of Object.values(baseline.agent_profiles.profiles)) {
  assert.notEqual(
    `${profile.model}/${profile.model_reasoning_effort}`,
    'gpt-5.6-luna/ultra',
    'Luna defaults must not request unsupported ultra effort'
  );
}
baseline.agent_profiles.profiles.dispatch_worker.model = 'gpt-6-astra';
baseline.agent_profiles.profiles.dispatch_worker.model_reasoning_effort = 'ultra';
function override(profile, base = baseline) {
  return mergeConfig(base, { agent_profiles: { profiles: { dispatch_worker: profile } } });
}
for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']) {
  const effective = override({ model });
  const profile = effective.agent_profiles.profiles.dispatch_worker;
  assert.equal(profile.model, model);
  assert.equal(profile.model_reasoning_effort, 'medium', 'model-only override does not inherit incompatible ultra');
  assert.match(renderAgentProfile('dispatch_worker', profile), /model_reasoning_effort = "medium"/);
  assert.deepEqual(modelEffortWarnings(effective), []);
}
assert.equal(override({ model: 'gpt-6-astra' }).agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'ultra', 'same model keeps prior effort');
assert.equal(override({ description: 'custom' }).agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'ultra');
const explicit = override({ model: 'gpt-5.5', model_reasoning_effort: 'xhigh' });
assert.equal(explicit.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'xhigh');
assert.deepEqual(modelEffortWarnings(explicit), []);
const invalidExplicit = override({ model: 'gpt-5.5', model_reasoning_effort: 'ultra' });
assert.equal(invalidExplicit.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'ultra', 'explicit configuration is not silently rewritten');
assert.match(modelEffortWarnings(invalidExplicit).join('\n'), /gpt-5.5\/ultra/);
assert.match(mainAgentGuidance(invalidExplicit), /gpt-5.5\/ultra.*配置保留/);
assert.match(mainAgentGuidance(invalidExplicit, true), /gpt-5.5\/ultra.*配置保留/);

const unknown = override({ model: 'private-future-model' });
assert.equal(unknown.agent_profiles.profiles.dispatch_worker.model, 'private-future-model');
assert.equal(unknown.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, '');
assert.match(modelEffortWarnings(unknown).join('\n'), /未记录 private-future-model 的能力/);
const inherit = override({ model: '' });
assert.equal(inherit.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, '');
assert.doesNotMatch(renderAgentProfile('dispatch_worker', inherit.agent_profiles.profiles.dispatch_worker), /^model(?:_reasoning_effort)? = /m);
const explicitInherit = override({ model: 'gpt-5.5', model_reasoning_effort: '' });
assert.equal(explicitInherit.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, '');
assert.match(modelEffortWarnings(explicitInherit).join('\n'), /继承主任务推理档位/);
const projectEffort = override({ model_reasoning_effort: 'high' }, explicit);
assert.equal(projectEffort.agent_profiles.profiles.dispatch_worker.model, 'gpt-5.5');
assert.equal(projectEffort.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'high');
assert.equal(baseline.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'ultra', 'merging must not mutate input');
invalidExplicit.agent_profiles.enabled = false;
assert.deepEqual(modelEffortWarnings(invalidExplicit), []);
