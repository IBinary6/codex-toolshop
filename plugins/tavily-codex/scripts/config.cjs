'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PROVIDERS = ['context7', 'exa', 'tavily'];
const PROFILES = {
  context7: { name: 'context7-codex', override: 'CONTEXT7_CODEX_CONFIG', key: true },
  exa: { name: 'exa-codex', override: 'EXA_CODEX_CONFIG', key: true },
  tavily: { name: 'tavily-codex', override: 'TAVILY_CODEX_CONFIG', key: true },
  microsoft: { name: 'microsoft-learn-codex', override: 'MICROSOFT_LEARN_CODEX_CONFIG', key: false },
  fetch: { name: 'fetch-codex', override: 'FETCH_CODEX_CONFIG', key: false },
  sequentialthinking: { name: 'sequential-thinking-codex', override: 'SEQUENTIAL_THINKING_CODEX_CONFIG', key: false }
};

class SafeError extends Error {}

function profile(provider) {
  if (provider === undefined) return undefined;
  if (!Object.hasOwn(PROFILES, provider)) throw new SafeError('Invalid Research Tools configuration provider.');
  return PROFILES[provider];
}

function configPath(env = process.env, home = os.homedir(), provider) {
  const selected = profile(provider);
  const override = env[selected ? selected.override : 'RESEARCH_TOOLS_CONFIG'];
  const root = env.CODEX_HOME || path.join(home, '.codex');
  // An explicit override must be absolute so plugin cache or cwd changes cannot move private configuration.
  if (!path.isAbsolute(override || root)) throw new SafeError('The Research Tools configuration path must be absolute.');
  return override || path.join(root, selected ? selected.name : 'research-tools', 'config.json');
}

function template(provider) {
  const selected = profile(provider);
  if (selected) return selected.key ? { version: 1, apiKey: '' } : { version: 1 };
  return { version: 1, context7: { apiKey: '' }, exa: { apiKey: '' }, tavily: { apiKey: '' } };
}

function readConfig(file, provider) {
  const selected = profile(provider);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT') value = template(provider);
    else throw new SafeError('Cannot read private Research Tools configuration or its JSON is invalid; run doctor.');
  }
  if (!value || value.version !== 1 || Array.isArray(value)) throw new SafeError('Private Research Tools configuration version must be 1.');
  const result = { version: 1 };
  if (selected) {
    if (selected.key && (typeof value.apiKey !== 'string' || /[\x00-\x1f\x7f]/.test(value.apiKey) || value.apiKey.length > 8192)) throw new SafeError(`${selected.name} apiKey must be a valid string; run doctor.`);
    result[provider] = { apiKey: selected.key ? value.apiKey.trim() : '' };
    return result;
  }
  for (const name of PROVIDERS) {
    const provider = value[name];
    if (!provider || typeof provider !== 'object' || Array.isArray(provider) || typeof provider.apiKey !== 'string' || /[\x00-\x1f\x7f]/.test(provider.apiKey) || provider.apiKey.length > 8192) {
      throw new SafeError(`Research Tools ${name}.apiKey must be a valid string; run doctor.`);
    }
    result[name] = { apiKey: provider.apiKey.trim() };
  }
  return result;
}

function createConfig(file, provider) {
  const bytes = provider === undefined ? fs.readFileSync(path.join(__dirname, '..', 'config.example.json')) : Buffer.from(JSON.stringify(template(provider), null, 2) + '\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw new SafeError('Cannot create private Research Tools configuration.'); }
}

module.exports = { PROVIDERS, PROFILES, SafeError, configPath, readConfig, createConfig, profile, template };
