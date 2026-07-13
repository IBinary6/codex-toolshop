'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_DIR = '.agent-dispatch-codex';
const CONFIG_FILE = 'config.json';
const OVERRIDE_KEYS = [
  'mcp_prefixes',
  'shell_heads',
  'prompt_keywords',
];

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
    Object.assign(result.policy, layer.policy);
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
        result.agent_profiles.profiles[name] = {
          ...(result.agent_profiles.profiles[name] || {}),
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

function gitRoot(cwd) {
  const value = gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  return value ? path.resolve(value) : null;
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

function ensureGitExclude(cwd) {
  const root = gitRoot(cwd);
  if (!root) return;
  const raw = gitOutput(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!raw) return;
  const exclude = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const entry = `${PROJECT_DIR}/`;
  const content = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (content.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(exclude, `${prefix}${entry}\n`, 'utf8');
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
  return result;
}

module.exports = {
  PROJECT_DIR,
  addRemove,
  ensureConfigFiles,
  ensureGitExclude,
  gitOutput,
  gitRoot,
  globalConfigPath,
  loadConfig,
  loadDefaults,
  mergeConfig,
  pluginDataDir,
  projectConfigPath,
};
