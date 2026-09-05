'use strict';

const fs = require('fs');
const path = require('path');
const { gitOutput, gitRoot } = require('./config');

const MANAGED_HEADER = '# Managed by agent-dispatch-codex. Configure via .agent-dispatch-codex/config.json.';
const GIT_HANDOFF = 'Do not run Git commands; leave all Git operations to the primary agent.';
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
  const requestedInstructions = typeof profile.developer_instructions === 'string'
    && profile.developer_instructions.trim()
    ? profile.developer_instructions.trim()
    : 'Execute the assigned bounded task and report changed files plus validation results.';
  const instructions = requestedInstructions.endsWith(GIT_HANDOFF)
    ? requestedInstructions
    : `${requestedInstructions} ${GIT_HANDOFF}`;
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
  if (!root || !settings) return result;
  const profiles = settings.profiles && typeof settings.profiles === 'object'
    && !Array.isArray(settings.profiles)
    ? settings.profiles
    : {};
  // 不沿链接写入项目外目录；保留用户手工链接的 agent 配置。
  const agentDir = path.join(root, '.codex', 'agents');
  for (const directory of [path.join(root, '.codex'), agentDir]) {
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
      result.preserved.push(path.relative(root, directory));
      return result;
    }
  }
  const names = new Set(Object.keys(profiles));
  if (fs.existsSync(agentDir)) {
    for (const entry of fs.readdirSync(agentDir, { withFileTypes: true })) {
      if (entry.name.endsWith('.toml')) names.add(entry.name.slice(0, -5));
    }
  }
  const excluded = [];
  for (const name of names) {
    const profile = profiles[name];
    if (!VALID_NAME.test(name) || (profile && (typeof profile !== 'object' || Array.isArray(profile)))) {
      result.preserved.push(name);
      continue;
    }
    const relative = relativeAgentPath(name);
    const target = path.join(root, ...relative.split('/'));
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if ((stat && !stat.isFile()) || isTracked(root, relative)) {
      result.preserved.push(relative);
      continue;
    }
    const existing = stat ? fs.readFileSync(target, 'utf8') : '';
    if (settings.enabled === false || !profile || profile.enabled === false) {
      if (existing && isManaged(existing)) {
        fs.unlinkSync(target);
        result.removed.push(relative);
      }
      continue;
    }
    if (stat && !isManaged(existing)) {
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
