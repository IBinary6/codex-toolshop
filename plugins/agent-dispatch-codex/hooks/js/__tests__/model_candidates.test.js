'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadDefaults, mergeConfig } = require('../lib/config');
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
];
const cache = (models, fetchedAt = new Date(now).toISOString()) => ({
  fetched_at: fetchedAt,
  models: models.map(([slug, efforts, visibility]) => ({
    slug,
    supported_reasoning_levels: efforts.map((effort) => ({ effort })),
    visibility,
  })),
});
const defaults = loadDefaults();
const supportedModels = new Set(['luna', 'terra', 'sol', 'astra']);
const defaultModels = new Set();
for (const settings of [defaults.policy.low_cost, ...Object.values(defaults.agent_profiles.profiles)]) {
  for (const pair of [settings, ...(settings.model_candidates || [])]) {
    if (!pair.model) continue;
    assert.ok(supportedModels.has(pair.model), `unexpected built-in model: ${pair.model}`);
    defaultModels.add(pair.model);
  }
}
assert.deepEqual(defaultModels, supportedModels, 'defaults use model families without version pins');
assert.equal(defaults.agent_profiles.profiles.dispatch_sol_worker.model_candidates, undefined);
assert.equal(defaults.agent_profiles.profiles.dispatch_sol_worker.model_reasoning_effort, 'high');
assert.equal(defaults.agent_profiles.profiles.dispatch_terra_worker.model, 'terra');
assert.equal(defaults.agent_profiles.profiles.dispatch_terra_worker.model_reasoning_effort, 'medium');
const base = {
  policy: {
    low_cost: {
      model: 'gpt-6-luna',
      model_reasoning_effort: 'max',
      model_candidates: [
        { model: 'gpt-6-luna', model_reasoning_effort: 'max' },
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
  whitelist: { prompt_keywords: [] },
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
  ['gpt-6-sol', ['medium']],
]).agent_profiles.profiles.dispatch_sol_worker.model, 'gpt-6-sol', 'GPT-6 Sol remains the compatible fallback');
assert.equal(resolved([
  ['gpt-6.1-sol', ['high'], 'hide'], ['gpt-6-sol', ['medium']],
]).agent_profiles.profiles.dispatch_sol_worker.model, 'gpt-6-sol', 'hidden model is excluded');
assert.equal(resolved([
  ['private-model', ['high']],
]).agent_profiles.profiles.dispatch_sol_worker.model, 'gpt-6-sol', 'unlisted candidates retain baseline');
assert.equal(resolved([
  ['gpt-6-luna', ['max']],
]).policy.low_cost.model, 'gpt-6-luna');
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
  agent_profiles: { profiles: { dispatch_sol_worker: { model: 'gpt-6-astra' } } },
}), { policy: { low_cost: { enabled: false } } });
assert.deepEqual(layeredPin.agent_profiles.profiles.dispatch_sol_worker.model_candidates, []);
assert.equal(layeredPin.agent_profiles.profiles.dispatch_sol_worker.model, 'gpt-6-astra');
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

// Family defaults discover future versions numerically, with exact family names and fixed effort.
const familyConfig = {
  ...base,
  policy: { low_cost: { model: 'LUNA', model_reasoning_effort: 'max' } },
  agent_profiles: { profiles: { worker: { model: 'SoL', model_reasoning_effort: 'high' } } },
};
const familyCatalog = parseModelCatalog(cache([
  ['gpt-5.6-sol', ['high']], ['gpt-6-sol', ['high']], ['gpt-6.1-sol', ['high']],
  ['gpt-6.9-sol', ['high']], ['gpt-6.10-sol', ['high']], ['gpt-7-sol', ['medium']],
  ['gpt-100-solaris', ['high']], ['gpt-101-solarium', ['high']],
  ['gpt-99-sol', ['high'], 'hide'], ['gpt-9-astra', ['high']],
  ['gpt-8-luna', ['medium']], ['gpt-7.2-luna', ['max']], ['gpt-next-sol', ['high']],
]), now);
const families = resolveModelCandidates(familyConfig, familyCatalog);
assert.equal(families.agent_profiles.profiles.worker.model, 'gpt-6.10-sol');
assert.equal(families.agent_profiles.profiles.worker.model_reasoning_effort, 'high');
assert.equal(families.agent_profiles.profiles.worker.model_resolution.family, 'sol');
assert.equal(families.policy.low_cost.model, 'gpt-7.2-luna');
assert.equal(familyConfig.agent_profiles.profiles.worker.model, 'SoL', 'family resolution preserves input');
assert.equal(mergeConfig(familyConfig, { agent_profiles: { profiles: { worker: { model: 'SOL' } } } }).agent_profiles.profiles.worker.model_reasoning_effort,
  'high', 'changing only alias case preserves the requested effort');
for (const [models, latest] of [
  [['gpt-5.6-sol', 'gpt-6-sol'], 'gpt-6-sol'],
  [['gpt-6-sol', 'gpt-6.1-sol'], 'gpt-6.1-sol'],
  [['gpt-6.1-sol', 'gpt-6.9-sol'], 'gpt-6.9-sol'],
  [['gpt-6.9-sol', 'gpt-6.10-sol'], 'gpt-6.10-sol'],
  [['gpt-9007199254740992-sol', 'gpt-9007199254740993-sol'], 'gpt-9007199254740993-sol'],
]) {
  const selected = resolveModelCandidates(familyConfig, parseModelCatalog(cache(models.reverse().map((model) => [model, ['high']])), now));
  assert.equal(selected.agent_profiles.profiles.worker.model, latest, 'numeric tuple order is independent of catalog order');
}
for (const invalidCatalog of [null, new Map(), parseModelCatalog(cache([['gpt-9-astra', ['high']]]), now)]) {
  const unresolved = resolveModelCandidates(familyConfig, invalidCatalog);
  assert.equal(unresolved.agent_profiles.profiles.worker.model, 'sol');
  assert.equal(unresolved.agent_profiles.profiles.worker.model_resolution.status, 'unresolved');
  assert.equal(unresolved.policy.low_cost.model, 'luna');
}
const familyWithoutEffort = mergeConfig(familyConfig, {
  agent_profiles: { profiles: { worker: { model_reasoning_effort: '' } } },
});
assert.equal(resolveModelCandidates(familyWithoutEffort, familyCatalog).agent_profiles.profiles.worker.model_resolution.reason, 'explicit-effort-required');
const familyPin = mergeConfig(familyConfig, {
  agent_profiles: { profiles: { worker: { model: 'gpt-6-sol', model_reasoning_effort: 'high' } } },
});
assert.equal(resolveModelCandidates(familyPin, familyCatalog).agent_profiles.profiles.worker.model, 'gpt-6-sol');
const familyUnpin = mergeConfig(familyConfig, { agent_profiles: { profiles: { worker: { model: '' } } } });
assert.equal(resolveModelCandidates(familyUnpin, familyCatalog).agent_profiles.profiles.worker.model, '');
assert.equal(resolveModelCandidates(familyUnpin, familyCatalog).agent_profiles.profiles.worker.model_reasoning_effort, '');
const familyDisabled = mergeConfig(familyConfig, { agent_profiles: { profiles: { worker: { enabled: false } } } });
assert.equal(resolveModelCandidates(familyDisabled, familyCatalog).agent_profiles.profiles.worker.model, 'SoL');
const familyLayered = mergeConfig(mergeConfig(familyConfig, {
  agent_profiles: { profiles: { worker: { model: 'astra', model_reasoning_effort: 'high' } } },
}), { agent_profiles: { profiles: { worker: { model: 'sol', model_reasoning_effort: 'high' } } } });
assert.equal(resolveModelCandidates(familyLayered, familyCatalog).agent_profiles.profiles.worker.model, 'gpt-6.10-sol');
assert.equal(selectCandidate([{ model: 'sol', model_reasoning_effort: 'high' }], new Map([['sol', new Set(['high'])]])), null, 'candidate aliases cannot escape to native settings');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dispatch-model-cache-'));
// Terra uses the same catalog contract, including future releases, effort fallback, pins, and missing catalogs.
const terraConfig = mergeConfig(defaults, {
  agent_profiles: { profiles: { dispatch_terra_worker: { model: 'TeRrA', model_reasoning_effort: 'medium' } } },
});
const terraProfile = (config) => config.agent_profiles.profiles.dispatch_terra_worker;
for (const [models, expected] of [
  [[['gpt-6.1-terra', ['medium']]], 'gpt-6.1-terra'],
  [[['gpt-6.1-terra', ['medium']], ['gpt-6.2-terra', ['medium']]], 'gpt-6.2-terra'],
  [[['gpt-6.2-terra', ['medium']], ['gpt-6.3-terra', ['medium']]], 'gpt-6.3-terra'],
  [[['gpt-6.9-terra', ['medium']], ['gpt-6.10-terra', ['medium']]], 'gpt-6.10-terra'],
  [[['gpt-6.3-terra', ['high']], ['gpt-6.2-terra', ['medium']]], 'gpt-6.2-terra'],
  [[['gpt-7-terra', ['medium'], 'hide'], ['gpt-6.3-terra', ['medium']]], 'gpt-6.3-terra'],
  [[['gpt-99-terrain', ['medium']], ['gpt-next-terra', ['medium']], ['gpt-6.1-terra', ['medium']]], 'gpt-6.1-terra'],
]) {
  const selected = terraProfile(resolveModelCandidates(terraConfig, parseModelCatalog(cache(models.reverse()), now)));
  assert.equal(selected.model, expected);
  assert.equal(selected.model_reasoning_effort, 'medium');
  assert.equal(selected.model_resolution.family, 'terra');
}
for (const invalidCatalog of [
  null, new Map(), parseModelCatalog(cache([['gpt-99-sol', ['medium']]]), now),
  parseModelCatalog(cache([['gpt-6.3-terra', ['high']]]), now),
  parseModelCatalog(cache([['gpt-6.3-terra', ['medium']]], new Date(now - CACHE_MAX_AGE_MS - 1).toISOString()), now),
  parseModelCatalog(cache([['gpt-6.3-terra', ['medium']]], new Date(now + 1).toISOString()), now),
]) {
  const selected = terraProfile(resolveModelCandidates(terraConfig, invalidCatalog));
  assert.equal(selected.model, 'terra');
  assert.equal(selected.model_resolution.status, 'unresolved');
}
const terraCatalog = parseModelCatalog(cache([['gpt-6.3-terra', ['medium']]]), now);
const terraPin = mergeConfig(terraConfig, {
  agent_profiles: { profiles: { dispatch_terra_worker: { model: 'gpt-6.1-terra', model_reasoning_effort: 'high' } } },
});
assert.equal(terraProfile(resolveModelCandidates(terraPin, terraCatalog)).model, 'gpt-6.1-terra', 'full-ID pin survives future versions');
assert.equal(terraProfile(resolveModelCandidates(terraPin, terraCatalog)).model_reasoning_effort, 'high');
const terraNoEffort = mergeConfig(terraConfig, {
  agent_profiles: { profiles: { dispatch_terra_worker: { model_reasoning_effort: '' } } },
});
assert.equal(terraProfile(resolveModelCandidates(terraNoEffort, terraCatalog)).model_resolution.reason, 'explicit-effort-required');
assert.equal(selectCandidate([{ model: 'terra', model_reasoning_effort: 'medium' }], new Map([['terra', new Set(['medium'])]])), null);
const terraProject = mergeConfig(mergeConfig(defaults, {
  agent_profiles: { profiles: { dispatch_terra_worker: { model: 'gpt-6.1-terra', model_reasoning_effort: 'high', custom_field: 'preserve' } } },
}), { agent_profiles: { profiles: { dispatch_terra_worker: { model: 'terra', model_reasoning_effort: 'medium' } } } });
assert.equal(terraProfile(resolveModelCandidates(terraProject, terraCatalog)).model, 'gpt-6.3-terra');
assert.equal(terraProfile(terraProject).custom_field, 'preserve', 'existing layer merge preserves unknown fields');
try {
  assert.equal(readModelCatalog({ codexHome: temp, now }), null, 'missing cache');
  const file = path.join(temp, 'models_cache.json');
  fs.writeFileSync(file, '{broken', 'utf8');
  assert.equal(readModelCatalog({ codexHome: temp, now }), null, 'damaged cache');
  fs.writeFileSync(file, JSON.stringify(cache([['gpt-99-sol', ['high']]], new Date(now - CACHE_MAX_AGE_MS - 1).toISOString())), 'utf8');
  assert.equal(resolveModelCandidates(familyConfig, readModelCatalog({ codexHome: temp, now })).agent_profiles.profiles.worker.model_resolution.status,
    'unresolved', 'stale file cannot pin a family');
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
