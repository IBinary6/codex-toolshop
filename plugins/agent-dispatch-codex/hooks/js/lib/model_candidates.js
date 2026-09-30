'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
    if (!candidate || typeof candidate.model !== 'string' || !candidate.model
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
  if (!catalog) return config;
  const result = { ...config };
  if (config.policy && config.policy.low_cost) {
    const lowCost = config.policy.low_cost;
    const selected = selectCandidate(lowCost.model_candidates, catalog);
    if (selected) {
      result.policy = { ...config.policy, low_cost: { ...lowCost, ...selected } };
    }
  }
  if (config.agent_profiles && config.agent_profiles.profiles) {
    const profiles = {};
    let changed = false;
    for (const [name, profile] of Object.entries(config.agent_profiles.profiles)) {
      const selected = profile && selectCandidate(profile.model_candidates, catalog);
      profiles[name] = selected ? { ...profile, ...selected } : profile;
      changed ||= !!selected;
    }
    if (changed) {
      result.agent_profiles = { ...config.agent_profiles, profiles };
    }
  }
  return result;
}

module.exports = {
  CACHE_MAX_AGE_MS,
  parseModelCatalog,
  readModelCatalog,
  resolveModelCandidates,
  selectCandidate,
};
