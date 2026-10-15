'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { modelFamily, versionedFamily, readModelCatalog, resolveModelCandidates } = require('./model_candidates');

const PROJECT_DIR = '.agent-dispatch-codex';
const CONFIG_FILE = 'config.json';
const OVERRIDE_KEYS = [
  'prompt_keywords',
];

function modelEffortWarnings(config, catalog = readModelCatalog()) {
  const settings = config && config.agent_profiles;
  const warnings = [];
  if (settings && settings.enabled !== false) {
    for (const [name, profile] of Object.entries(settings.profiles || {})) {
      if (!profile || profile.enabled === false) continue;
      const model = typeof profile.model === 'string' ? profile.model.trim() : '';
      const effort = typeof profile.model_reasoning_effort === 'string'
        ? profile.model_reasoning_effort.trim() : '';
      if (!model) continue;
      warnings.push(...settingWarnings(name, profile, model, effort, catalog));
    }
  }

  const lowCost = config && config.policy && config.policy.low_cost;
  if (lowCost && lowCost.enabled !== false) {
    const model = typeof lowCost.model === 'string' ? lowCost.model.trim() : '';
    const effort = typeof lowCost.model_reasoning_effort === 'string'
      ? lowCost.model_reasoning_effort.trim() : '';
    if (!model) {
      warnings.push('policy.low_cost: No model configured; the low-cost route cannot confirm its target model.');
    } else {
      warnings.push(...settingWarnings('policy.low_cost', lowCost, model, effort, catalog));
    }
  }
  return warnings;
}

function settingWarnings(name, settings, model, effort, catalog) {
  if (modelFamily(model)) {
    const reason = settings.model_resolution?.reason || 'family-not-resolved';
    return [`${name}: ${model}/${effort || 'inherit'} family unresolved (${reason}); no native role is generated. Refresh the host model catalog or explicitly pin a host-supported full model ID and effort. Use a supported generic role with an explicit pair or primary-agent work; never pass the family alias to native model APIs or inherit an expensive parent model implicitly.`];
  }
  const supported = catalog && catalog.get(model);
  if (!supported) return [`${name}: No fresh visible capability record for ${model}; configuration is preserved. Verify host support without mapping it to another model.`];
  if (effort && !supported.has(effort)) return [`${name}: ${model}/${effort} is unsupported by the fresh catalog (${[...supported].join(', ')}); configuration is preserved. Verify host support before spawning without silently replacing an explicit model or reducing effort.`];
  if (!effort) return [`${name}: ${model} inherits the primary task's reasoning effort; verify support before spawning.`];
  return [];
}

function pluginRoot() {
  return process.env.PLUGIN_ROOT
    ? path.resolve(process.env.PLUGIN_ROOT)
    : path.resolve(__dirname, '..', '..', '..');
}

function pluginDataDir() {
  if (process.env.PLUGIN_DATA) return path.resolve(process.env.PLUGIN_DATA);
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'plugins', 'data', 'agent-dispatch-codex');
}

function loadDefaults() {
  const file = path.join(pluginRoot(), 'defaults', 'dispatch-rules.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    process.stderr.write(`[agent-dispatch-codex] invalid config ${file}: ${error.message}\n`);
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function addRemove(existing, add, remove) {
  const removed = new Set(asArray(remove).map(String));
  return Array.from(new Set([...asArray(existing), ...asArray(add)].map(String)))
    .filter((item) => !removed.has(item));
}

function mergeConfig(base, layer) {
  const result = JSON.parse(JSON.stringify(base));
  if (!layer || typeof layer !== 'object') return result;
  if (layer.modules && typeof layer.modules === 'object' && !Array.isArray(layer.modules)) {
    Object.assign(result.modules, layer.modules);
  }
  if (layer.policy && typeof layer.policy === 'object' && !Array.isArray(layer.policy)) {
    const lowCost = layer.policy.low_cost;
    const policy = { ...layer.policy };
    delete policy.low_cost;
    Object.assign(result.policy, policy);
    if (lowCost && typeof lowCost === 'object' && !Array.isArray(lowCost)) {
      result.policy.low_cost = {
        ...(result.policy.low_cost || {}),
        ...((Object.hasOwn(lowCost, 'model') || Object.hasOwn(lowCost, 'model_reasoning_effort'))
          && !Object.hasOwn(lowCost, 'model_candidates') ? { model_candidates: [] } : {}),
        ...lowCost,
      };
    }
  }
  if (layer.agent_profiles && typeof layer.agent_profiles === 'object'
      && !Array.isArray(layer.agent_profiles)) {
    result.agent_profiles = result.agent_profiles || { enabled: true, profiles: {} };
    if (typeof layer.agent_profiles.enabled === 'boolean') {
      result.agent_profiles.enabled = layer.agent_profiles.enabled;
    }
    const profiles = layer.agent_profiles.profiles;
    if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
      result.agent_profiles.profiles = result.agent_profiles.profiles || {};
      for (const [name, profile] of Object.entries(profiles)) {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
        const previous = result.agent_profiles.profiles[name] || {};
        const changesModel = typeof profile.model === 'string'
          && (modelFamily(profile.model) || profile.model.trim())
            !== (modelFamily(previous.model) || String(previous.model || '').trim());
        result.agent_profiles.profiles[name] = {
          ...previous,
          ...((Object.hasOwn(profile, 'model') || Object.hasOwn(profile, 'model_reasoning_effort'))
            && !Object.hasOwn(profile, 'model_candidates') ? { model_candidates: [] } : {}),
          // A changed family or recognized versioned pin starts at the medium preset; catalog resolution validates support later.
          // An explicit effort in this layer, including an empty string, always wins.
          ...(changesModel ? {
            model_reasoning_effort: modelFamily(profile.model) || versionedFamily(profile.model.trim()) ? 'medium' : '',
          } : {}),
          ...profile,
        };
      }
    }
  }
  const overrides = layer.overrides && typeof layer.overrides === 'object'
    ? layer.overrides
    : {};
  for (const key of OVERRIDE_KEYS) {
    result.whitelist[key] = addRemove(
      result.whitelist[key],
      overrides[`${key}_add`],
      overrides[`${key}_remove`]
    );
  }
  return result;
}

function gitOutput(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return '';
  }
}

// A hook looks the same directory up several times (config files, ignore rules, agent profiles); ask git once.
// Only successes are remembered, so a directory that becomes a repository later is still found.
const gitRoots = new Map();

function gitRoot(cwd) {
  if (gitRoots.has(cwd)) return gitRoots.get(cwd);
  const value = gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  if (!value) return null;
  const root = path.resolve(value);
  gitRoots.set(cwd, root);
  return root;
}

function globalConfigPath() {
  return path.join(pluginDataDir(), CONFIG_FILE);
}

function projectConfigPath(cwd) {
  const root = gitRoot(cwd);
  return root ? path.join(root, PROJECT_DIR, CONFIG_FILE) : null;
}

function skeleton(doc) {
  const defaults = loadDefaults();
  const overrides = {};
  for (const key of OVERRIDE_KEYS) {
    overrides[`${key}_add`] = [];
    overrides[`${key}_remove`] = [];
  }
  return {
    schema_version: defaults.schema_version,
    _doc: doc,
    modules: {},
    policy: {},
    agent_profiles: {
      _doc: 'Override model, model_reasoning_effort, sandbox_mode, or enabled per generated Codex agent.',
      profiles: {},
    },
    overrides,
  };
}

function writeJsonIfMissing(file, value) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Append the entries that are not yet in the repository's local exclude file, which is never committed. */
function appendGitExclude(root, entries) {
  if (!entries.length) return;
  const raw = gitOutput(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!raw) return;
  const exclude = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const content = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  const present = new Set(content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = entries.filter((entry) => !present.has(entry));
  if (!missing.length) return;
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(exclude, `${prefix}${missing.join('\n')}\n`, 'utf8');
}

function ensureGitExclude(cwd) {
  const root = gitRoot(cwd);
  if (root) appendGitExclude(root, [`${PROJECT_DIR}/`]);
}

function ensureConfigFiles(cwd) {
  writeJsonIfMissing(globalConfigPath(), skeleton('Agent Dispatch global overrides for Codex.'));
  const projectFile = projectConfigPath(cwd);
  if (projectFile) {
    writeJsonIfMissing(projectFile, skeleton('Agent Dispatch project overrides for Codex.'));
    ensureGitExclude(cwd);
  }
  return { global: globalConfigPath(), project: projectFile };
}

function loadConfig(cwd) {
  let result = loadDefaults();
  result = mergeConfig(result, readJson(globalConfigPath()));
  const projectFile = projectConfigPath(cwd);
  if (projectFile) result = mergeConfig(result, readJson(projectFile));
  return resolveModelCandidates(result, readModelCatalog());
}

module.exports = {
  PROJECT_DIR,
  addRemove,
  appendGitExclude,
  ensureConfigFiles,
  ensureGitExclude,
  gitOutput,
  gitRoot,
  globalConfigPath,
  loadConfig,
  loadDefaults,
  mergeConfig,
  modelEffortWarnings,
  pluginDataDir,
  projectConfigPath,
  readModelCatalog,
  resolveModelCandidates,
};
