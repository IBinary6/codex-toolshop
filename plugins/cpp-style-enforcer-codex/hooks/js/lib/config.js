'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Hard-coded safe defaults when both global and project configuration are missing or invalid. */
const DEFAULT_CONFIG = {
  enabled: true,
  mode: 'incremental',
  lineEnding: 'preserve',
  checks: { clangFormat: true, copyright: true, cpplint: true, bom: true },
  legacyChecks: { clangFormat: false, copyright: false, cpplint: false, bom: false },
  copyrightInfo: { company: '', author: '', dateFormat: 'YYYY/MM/DD HH:mm' },
};
const PROJECT_CONFIG_DIRS = ['.codex-cpp-style', '.claude-cpp-style'];

/** Default global template path ~/.codex/cpp-style-template.json */
function userTemplatePath() {
  return path.join(os.homedir(), '.codex', 'cpp-style-template.json');
}

/**
 * Copy factory defaults only when the user global template is missing; never overwrite it. Ignore copy failures.
 * @param {string} defaultPath Absolute path to the factory-default plugin template
 * @param {string} [userPath] User template path (default ~/.codex/cpp-style-template.json)
 * @returns {string} User template path
 */
function ensureUserTemplate(defaultPath, userPath = userTemplatePath()) {
  try {
    if (fs.existsSync(userPath)) return userPath;
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.copyFileSync(defaultPath, userPath);
  } catch (_) {
    // On permission or missing-source errors, fall back to hard-coded defaults without crashing.
  }
  return userPath;
}

/** Read a JSON file safely, returning null on failure. */
function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

/** Search upward from the edited file for project cpp-style.json, preferring the Codex path while supporting the legacy Claude path. */
function findProjectConfig(filePath) {
  try {
    let dir = path.dirname(path.resolve(filePath));
    let prev = null;
    while (dir && dir !== prev) {
      for (const name of PROJECT_CONFIG_DIRS) {
        const candidate = path.join(dir, name, 'cpp-style.json');
        if (fs.existsSync(candidate)) return candidate;
      }
      prev = dir;
      dir = path.dirname(dir);
    }
  } catch (_) {}
  return null;
}

/** Normalize by merging base and override per field; comments document defaults for missing checks and legacyChecks fields. */
function normalize(base, override) {
  const merged = { ...DEFAULT_CONFIG, ...base, ...override };
  const checksIn = { ...DEFAULT_CONFIG.checks, ...(base && base.checks), ...(override && override.checks) };
  const checks = {
    clangFormat: checksIn.clangFormat !== false,
    copyright: checksIn.copyright !== false,
    cpplint: checksIn.cpplint !== false,
    bom: checksIn.bom !== false,
  };
  // legacyChecks: Per-check switches for tracked files; all default off to preserve their encoding and formatting.
  const legacyIn = { ...DEFAULT_CONFIG.legacyChecks, ...(base && base.legacyChecks), ...(override && override.legacyChecks) };
  const legacyChecks = {
    clangFormat: legacyIn.clangFormat === true,
    copyright: legacyIn.copyright === true,
    cpplint: legacyIn.cpplint === true,
    bom: legacyIn.bom === true,
  };
  const copyrightInfo = {
    ...DEFAULT_CONFIG.copyrightInfo,
    ...(base && base.copyrightInfo),
    ...(override && override.copyrightInfo),
  };
  return {
    enabled: merged.enabled !== false,
    mode: merged.mode === 'full' ? 'full' : 'incremental',
    lineEnding: ['lf', 'crlf'].includes(merged.lineEnding) ? merged.lineEnding : 'preserve',
    checks,
    legacyChecks,
    copyrightInfo,
  };
}

/**
 * Read the global template with project overrides per field and return normalized configuration.
 * Use defaults without crashing when global or project configuration is missing or invalid.
 * @param {string} filePath Edited file path
 * @param {string} [globalPath] Global template path (default ~/.codex/cpp-style-template.json)
 * @returns {{enabled:boolean, mode:string, checks:object, copyrightInfo:object}}
 */
function loadConfig(filePath, globalPath = userTemplatePath()) {
  const global = readJsonSafe(globalPath) || {};
  const projectPath = filePath ? findProjectConfig(filePath) : null;
  const project = (projectPath && readJsonSafe(projectPath)) || {};
  return normalize(global, project);
}

module.exports = { loadConfig, ensureUserTemplate, userTemplatePath, DEFAULT_CONFIG, PROJECT_CONFIG_DIRS };
