'use strict';

const assert = require('assert').strict;
const { mergeConfig, modelEffortWarnings } = require('../lib/config');
const { defaults: loadDefaults } = require('./model_fixture.cjs');
const { renderAgentProfile } = require('../lib/agent_profiles');
const { mainAgentGuidance } = require('../lib/guidance');

const baseline = loadDefaults();
assert.equal(Object.keys(baseline.agent_profiles.profiles).length, 13);
assert.deepEqual(modelEffortWarnings(baseline), []);
const invalidLowCost = mergeConfig(loadDefaults(), {
  policy: { low_cost: { model_reasoning_effort: 'ultra' } },
});
assert.match(modelEffortWarnings(invalidLowCost).join('\n'), /policy\.low_cost.*gpt-6-luna\/ultra/);
for (const profile of Object.values(baseline.agent_profiles.profiles)) {
  assert.notEqual(
    `${profile.model}/${profile.model_reasoning_effort}`,
    'gpt-6-luna/ultra',
    'Luna defaults must not request unsupported ultra effort'
  );
}
baseline.agent_profiles.profiles.dispatch_worker.model = 'gpt-6-astra';
baseline.agent_profiles.profiles.dispatch_worker.model_reasoning_effort = 'ultra';
function override(profile, base = baseline) {
  return mergeConfig(base, { agent_profiles: { profiles: { dispatch_worker: profile } } });
}
for (const model of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-terra']) {
  const effective = override({ model });
  const profile = effective.agent_profiles.profiles.dispatch_worker;
  assert.equal(profile.model, model);
  assert.equal(profile.model_reasoning_effort, 'medium', 'model-only override does not inherit incompatible ultra');
  assert.match(renderAgentProfile('dispatch_worker', profile), /model_reasoning_effort = "medium"/);
  assert.deepEqual(modelEffortWarnings(effective), []);
}
assert.equal(override({ model: 'gpt-6-astra' }).agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'ultra', 'same model keeps prior effort');
assert.equal(override({ description: 'custom' }).agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'ultra');
for (const model of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']) {
  assert.deepEqual(modelEffortWarnings(override({ model, model_reasoning_effort: 'ultra' })), [],
    `${model} supports ultra in the recorded host snapshot`);
}
const explicit = override({ model: 'gpt-6.1-sol', model_reasoning_effort: 'xhigh' });
assert.equal(explicit.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'xhigh');
assert.deepEqual(modelEffortWarnings(explicit), []);
const invalidExplicit = override({ model: 'gpt-6-luna', model_reasoning_effort: 'ultra' });
assert.equal(invalidExplicit.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'ultra', 'explicit configuration is not silently rewritten');
assert.match(modelEffortWarnings(invalidExplicit).join('\n'), /gpt-6-luna\/ultra/);
assert.match(mainAgentGuidance(invalidExplicit), /gpt-6-luna\/ultra.*configuration is preserved/);
assert.match(mainAgentGuidance(invalidExplicit, true), /gpt-6-luna\/ultra.*configuration is preserved/);

const unknown = override({ model: 'private-future-model' });
assert.equal(unknown.agent_profiles.profiles.dispatch_worker.model, 'private-future-model');
assert.equal(unknown.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, '');
assert.match(modelEffortWarnings(unknown).join('\n'), /No fresh visible capability record for private-future-model/);
const inherit = override({ model: '' });
assert.equal(inherit.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, '');
assert.doesNotMatch(renderAgentProfile('dispatch_worker', inherit.agent_profiles.profiles.dispatch_worker), /^model(?:_reasoning_effort)? = /m);
const explicitInherit = override({ model: 'gpt-6.1-sol', model_reasoning_effort: '' });
assert.equal(explicitInherit.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, '');
assert.match(modelEffortWarnings(explicitInherit).join('\n'), /inherits the primary task/);
const projectEffort = override({ model_reasoning_effort: 'high' }, explicit);
assert.equal(projectEffort.agent_profiles.profiles.dispatch_worker.model, 'gpt-6.1-sol');
assert.equal(projectEffort.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'high');
assert.equal(baseline.agent_profiles.profiles.dispatch_worker.model_reasoning_effort, 'ultra', 'merging must not mutate input');
invalidExplicit.agent_profiles.enabled = false;
assert.deepEqual(modelEffortWarnings(invalidExplicit), []);
