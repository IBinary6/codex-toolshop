'use strict';

const fs = require('fs');
const path = require('path');
const { gitOutput, gitRoot } = require('./config');

const MANAGED_HEADER = '# Managed by agent-dispatch-codex. Configure via .agent-dispatch-codex/config.json.';
const VALID_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function tomlString(value) {
  return JSON.stringify(String(value));
}

function relativeAgentPath(name) {
  return `.codex/agents/${name}.toml`;
}

function renderAgentProfile(name, profile) {
  if (!VALID_NAME.test(name)) throw new Error(`invalid custom agent name: ${name}`);
  const description = profile.description || `Agent Dispatch custom agent ${name}.`;
  const instructions = profile.developer_instructions
    || 'Execute the assigned bounded task and report changed files plus validation results.';
  const lines = [
    MANAGED_HEADER,
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
  ];
  for (const key of ['model', 'model_reasoning_effort', 'sandbox_mode']) {
    if (typeof profile[key] === 'string' && profile[key].trim()) {
      lines.push(`${key} = ${tomlString(profile[key].trim())}`);
    }
  }
  lines.push(`developer_instructions = ${tomlString(instructions)}`);
  return `${lines.join('\n')}\n`;
}

function isManaged(content) {
  return content.startsWith(MANAGED_HEADER);
}

function addExcludeEntries(root, entries) {
  if (!entries.length) return;
  const raw = gitOutput(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!raw) return;
  const target = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = entries.filter((entry) => !lines.has(entry));
  if (!missing.length) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(target, `${prefix}${missing.join('\n')}\n`, 'utf8');
}

function isTracked(root, relative) {
  return Boolean(gitOutput(root, ['ls-files', '--error-unmatch', '--', relative]));
}

function ensureAgentProfiles(cwd, config) {
  const root = gitRoot(cwd);
  const settings = config && config.agent_profiles;
  const result = { root, written: [], removed: [], preserved: [] };
  if (!root || !settings || settings.enabled === false) return result;
  const profiles = settings.profiles && typeof settings.profiles === 'object'
    ? settings.profiles
    : {};
  const excluded = [];
  for (const [name, profile] of Object.entries(profiles)) {
    if (!VALID_NAME.test(name) || !profile || typeof profile !== 'object' || Array.isArray(profile)) {
      result.preserved.push(name);
      continue;
    }
    const relative = relativeAgentPath(name);
    const target = path.join(root, ...relative.split('/'));
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (profile.enabled === false) {
      if (existing && isManaged(existing)) {
        fs.unlinkSync(target);
        result.removed.push(relative);
      }
      continue;
    }
    if ((existing && !isManaged(existing)) || (!existing && isTracked(root, relative))) {
      result.preserved.push(relative);
      continue;
    }
    const content = renderAgentProfile(name, profile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (existing !== content) {
      fs.writeFileSync(target, content, 'utf8');
      result.written.push(relative);
    }
    excluded.push(relative);
  }
  addExcludeEntries(root, excluded);
  return result;
}

function profileSummary(config) {
  const settings = config && config.agent_profiles;
  if (!settings || settings.enabled === false || !settings.profiles) return [];
  return Object.entries(settings.profiles)
    .filter(([name, profile]) => VALID_NAME.test(name) && profile && profile.enabled !== false)
    .map(([name, profile]) => {
      const model = typeof profile.model === 'string' && profile.model.trim()
        ? profile.model.trim()
        : 'inherit';
      const effort = typeof profile.model_reasoning_effort === 'string'
        && profile.model_reasoning_effort.trim()
        ? profile.model_reasoning_effort.trim()
        : 'inherit';
      return `${name} (${model}, ${effort})`;
    });
}

module.exports = {
  MANAGED_HEADER,
  ensureAgentProfiles,
  profileSummary,
  relativeAgentPath,
  renderAgentProfile,
};
