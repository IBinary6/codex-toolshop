'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mergeConfig } = require('../lib/config');
const {
  CACHE_MAX_AGE_MS,
  parseModelCatalog,
  readModelCatalog,
  resolveModelCandidates,
  selectCandidate,
} = require('../lib/model_candidates');

const now = Date.parse('2026-09-29T12:00:00Z');
const candidates = [
  { model: 'gpt-6.1-sol', model_reasoning_effort: 'high' },
  { model: 'gpt-6-sol', model_reasoning_effort: 'medium' },
  { model: 'gpt-5.6-sol', model_reasoning_effort: 'medium' },
];
const cache = (models, fetchedAt = new Date(now).toISOString()) => ({
  fetched_at: fetchedAt,
  models: models.map(([slug, efforts, visibility]) => ({
    slug,
    supported_reasoning_levels: efforts.map((effort) => ({ effort })),
    visibility,
  })),
});
const base = {
  policy: {
    low_cost: {
      model: 'gpt-6-luna',
      model_reasoning_effort: 'max',
      model_candidates: [
        { model: 'gpt-6-luna', model_reasoning_effort: 'max' },
        { model: 'gpt-5.6-luna', model_reasoning_effort: 'max' },
      ],
    },
  },
  agent_profiles: {
    profiles: {
      dispatch_sol_worker: {
        model: 'gpt-6-sol',
        model_reasoning_effort: 'medium',
        model_candidates: candidates,
      },
    },
  },
  whitelist: { mcp_prefixes: [], shell_heads: [], prompt_keywords: [] },
};

function resolved(models) {
  return resolveModelCandidates(base, parseModelCatalog(cache(models), now));
}

assert.deepEqual(selectCandidate(candidates, parseModelCatalog(cache([
  ['gpt-6.1-sol', ['high']], ['gpt-6-sol', ['medium']],
]), now)), candidates[0], 'first supported candidate wins');
assert.deepEqual(resolved([
  ['gpt-6.1-sol', ['high']], ['gpt-6-sol', ['medium']],
]).agent_profiles.profiles.dispatch_sol_worker.model_reasoning_effort, 'high');
assert.equal(resolved([
  ['gpt-6.1-sol', ['medium']], ['gpt-6-sol', ['medium']],
]).agent_profiles.profiles.dispatch_sol_worker.model, 'gpt-6-sol', 'missing high skips 6.1');
assert.equal(resolved([
  ['gpt-5.6-sol', ['medium']],
]).agent_profiles.profiles.dispatch_sol_worker.model, 'gpt-5.6-sol', 'older model remains usable');
assert.equal(resolved([
  ['gpt-6.1-sol', ['high'], 'hide'], ['gpt-6-sol', ['medium']],
]).agent_profiles.profiles.dispatch_sol_worker.model, 'gpt-6-sol', 'hidden model is excluded');
assert.equal(resolved([
  ['private-model', ['high']],
]).agent_profiles.profiles.dispatch_sol_worker.model, 'gpt-6-sol', 'unlisted candidates retain baseline');
assert.equal(resolved([
  ['gpt-5.6-luna', ['max']],
]).policy.low_cost.model, 'gpt-5.6-luna');
assert.equal(base.agent_profiles.profiles.dispatch_sol_worker.model, 'gpt-6-sol', 'input stays unchanged');
assert.deepEqual(base.agent_profiles.profiles.dispatch_sol_worker.model_candidates, candidates);

for (const invalid of [null, {}, { fetched_at: 'bad', models: [] },
  cache([], new Date(now - CACHE_MAX_AGE_MS - 1).toISOString()),
  cache([], new Date(now + 1).toISOString())]) {
  assert.equal(parseModelCatalog(invalid, now), null);
  assert.equal(resolveModelCandidates(base, parseModelCatalog(invalid, now)), base);
}
assert.ok(parseModelCatalog(cache([], new Date(now - CACHE_MAX_AGE_MS).toISOString()), now));

const pinnedModel = mergeConfig(base, {
  agent_profiles: { profiles: { dispatch_sol_worker: { model: 'gpt-6-sol' } } },
});
assert.deepEqual(pinnedModel.agent_profiles.profiles.dispatch_sol_worker.model_candidates, []);
assert.equal(resolveModelCandidates(pinnedModel, parseModelCatalog(cache([
  ['gpt-6.1-sol', ['high']],
]), now)).agent_profiles.profiles.dispatch_sol_worker.model, 'gpt-6-sol');
for (const value of ['', 'medium']) {
  const pinnedEffort = mergeConfig(base, {
    agent_profiles: { profiles: { dispatch_sol_worker: { model_reasoning_effort: value } } },
  });
  assert.deepEqual(pinnedEffort.agent_profiles.profiles.dispatch_sol_worker.model_candidates, []);
  assert.equal(pinnedEffort.agent_profiles.profiles.dispatch_sol_worker.model_reasoning_effort, value);
}
const pinnedLowCost = mergeConfig(base, { policy: { low_cost: { model: 'gpt-6-luna' } } });
assert.deepEqual(pinnedLowCost.policy.low_cost.model_candidates, []);
const emptyModel = mergeConfig(base, {
  agent_profiles: { profiles: { dispatch_sol_worker: { model: '' } } },
});
assert.deepEqual(emptyModel.agent_profiles.profiles.dispatch_sol_worker.model_candidates, []);
assert.equal(emptyModel.agent_profiles.profiles.dispatch_sol_worker.model_reasoning_effort, '');
const emptyLowCostEffort = mergeConfig(base, {
  policy: { low_cost: { model_reasoning_effort: '' } },
});
assert.deepEqual(emptyLowCostEffort.policy.low_cost.model_candidates, []);
assert.equal(emptyLowCostEffort.policy.low_cost.model_reasoning_effort, '');
const layeredPin = mergeConfig(mergeConfig(base, {
  agent_profiles: { profiles: { dispatch_sol_worker: { model: 'gpt-5.6-sol' } } },
}), { policy: { low_cost: { enabled: false } } });
assert.deepEqual(layeredPin.agent_profiles.profiles.dispatch_sol_worker.model_candidates, []);
const disabled = mergeConfig(base, {
  agent_profiles: { profiles: { dispatch_sol_worker: { model_candidates: [] } } },
  policy: { low_cost: { model_candidates: [] } },
});
assert.equal(resolveModelCandidates(disabled, parseModelCatalog(cache([
  ['gpt-6.1-sol', ['high']], ['gpt-6-luna', ['max']],
]), now)).agent_profiles.profiles.dispatch_sol_worker.model, 'gpt-6-sol');
assert.deepEqual(mergeConfig(base, {
  agent_profiles: { profiles: { dispatch_sol_worker: {
    model: 'gpt-6-sol', model_candidates: candidates,
  } } },
}).agent_profiles.profiles.dispatch_sol_worker.model_candidates, candidates,
'same-layer explicit candidates remain active');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dispatch-model-cache-'));
try {
  assert.equal(readModelCatalog({ codexHome: temp, now }), null, 'missing cache');
  const file = path.join(temp, 'models_cache.json');
  fs.writeFileSync(file, '{broken', 'utf8');
  assert.equal(readModelCatalog({ codexHome: temp, now }), null, 'damaged cache');
  fs.writeFileSync(file, JSON.stringify(cache([['gpt-6.1-sol', ['high']]])), 'utf8');
  assert.ok(readModelCatalog({ codexHome: temp, now }).has('gpt-6.1-sol'));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = temp;
  try {
    assert.ok(readModelCatalog({ now }).has('gpt-6.1-sol'), 'CODEX_HOME cache is read');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
