'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function modelFamily(model) {
  return typeof model === 'string' && /^(luna|sol|astra)$/i.test(model.trim())
    ? model.trim().toLowerCase() : '';
}

/** Only documented versioned GPT family IDs participate; pins outside this format remain exact pins. */
function versionedFamily(model) {
  const match = /^gpt-(\d+(?:\.\d+)*)-(luna|sol|astra)$/i.exec(model);
  return match ? { family: match[2].toLowerCase(), version: match[1].split('.').map(BigInt) } : null;
}

function unresolvedModel(settings) {
  return Boolean(settings && modelFamily(settings.model));
}

function selectFamily(family, effort, catalog) {
  if (!catalog || !effort) return null;
  const compatible = [...catalog].map(([model, efforts]) => ({ model, efforts, parsed: versionedFamily(model) }))
    .filter(({ efforts, parsed }) => parsed && parsed.family === family && efforts.has(effort));
  compatible.sort((a, b) => {
    for (let i = 0; i < Math.max(a.parsed.version.length, b.parsed.version.length); i += 1) {
      const left = a.parsed.version[i] || 0n;
      const right = b.parsed.version[i] || 0n;
      if (left !== right) return left > right ? -1 : 1;
    }
    // Equivalent numeric versions keep catalog order; string ordering never decides version precedence.
    return 0;
  });
  return compatible.length ? { model: compatible[0].model, model_reasoning_effort: effort } : null;
}

function parseModelCatalog(cache, now = Date.now()) {
  if (!cache || !Array.isArray(cache.models) || typeof cache.fetched_at !== 'string') return null;
  const fetchedAt = Date.parse(cache.fetched_at);
  if (!Number.isFinite(fetchedAt) || fetchedAt > now || now - fetchedAt > CACHE_MAX_AGE_MS) return null;

  const catalog = new Map();
  for (const entry of cache.models) {
    if (!entry || typeof entry.slug !== 'string' || !entry.slug
        || !Array.isArray(entry.supported_reasoning_levels)
        || (entry.visibility && entry.visibility !== 'list')) continue;
    const efforts = new Set(entry.supported_reasoning_levels
      .filter((level) => level && typeof level.effort === 'string' && level.effort)
      .map((level) => level.effort));
    catalog.set(entry.slug, efforts);
  }
  return catalog;
}

function readModelCatalog(options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8'));
    return parseModelCatalog(cache, options.now);
  } catch (_) {
    return null;
  }
}

function selectCandidate(candidates, catalog) {
  if (!Array.isArray(candidates) || !catalog) return null;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.model !== 'string' || !candidate.model || modelFamily(candidate.model)
        || typeof candidate.model_reasoning_effort !== 'string'
        || !candidate.model_reasoning_effort) continue;
    const efforts = catalog.get(candidate.model);
    if (efforts && efforts.has(candidate.model_reasoning_effort)) {
      return {
        model: candidate.model,
        model_reasoning_effort: candidate.model_reasoning_effort,
      };
    }
  }
  return null;
}

function resolveModelCandidates(config, catalog) {
  function resolve(settings) {
    if (!settings || settings.enabled === false) return settings;
    const selected = selectCandidate(settings.model_candidates, catalog);
    const family = modelFamily(settings.model);
    if (selected) return { ...settings, ...selected };
    if (!family) return settings;
    const effort = typeof settings.model_reasoning_effort === 'string' ? settings.model_reasoning_effort.trim() : '';
    const latest = selectFamily(family, effort, catalog);
    return {
      ...settings,
      ...(latest || { model: family }),
      model_resolution: {
        family,
        status: latest ? 'resolved' : 'unresolved',
        reason: latest ? 'latest-compatible-family-model'
          : !catalog ? 'catalog-unavailable-or-stale'
            : !effort ? 'explicit-effort-required' : 'no-compatible-visible-family-model',
      },
    };
  }
  const result = { ...config };
  if (config.policy && config.policy.low_cost) {
    const lowCost = config.policy.low_cost;
    const resolved = resolve(lowCost);
    if (resolved !== lowCost) result.policy = { ...config.policy, low_cost: resolved };
  }
  if (config.agent_profiles && config.agent_profiles.profiles) {
    const profiles = {};
    let changed = false;
    for (const [name, profile] of Object.entries(config.agent_profiles.profiles)) {
      profiles[name] = config.agent_profiles.enabled === false ? profile : resolve(profile);
      changed ||= profiles[name] !== profile;
    }
    if (changed) {
      result.agent_profiles = { ...config.agent_profiles, profiles };
    }
  }
  return result.policy !== config.policy || result.agent_profiles !== config.agent_profiles ? result : config;
}

module.exports = {
  CACHE_MAX_AGE_MS,
  modelFamily,
  versionedFamily,
  unresolvedModel,
  parseModelCatalog,
  readModelCatalog,
  resolveModelCandidates,
  selectCandidate,
  selectFamily,
};
