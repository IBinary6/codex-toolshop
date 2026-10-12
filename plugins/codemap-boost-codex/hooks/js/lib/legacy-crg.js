'use strict';

// Removal of what earlier versions of this plugin left behind: global MCP registrations, Codex hooks and Git hooks.
// Everything here can be deleted once those versions are no longer in use.
const fs = require('fs');
const path = require('path');
const { parseMcpJson, mcpTransport, resolveCodexCommand, runCodexMcp } = require('./codex-cli');
const { codexHome, ensureDir, gitPath, markerPath, repoRoot, writeMarker } = require('./runtime');

const LEGACY_MCP_CHECKED_MARKER = '.legacy-crg-mcp-checked';

const LEGACY_MCP_RETRY_MS = 24 * 60 * 60 * 1000;

function normalizeLegacyCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

function isLegacyCrgCommand(command) {
  const normalized = normalizeLegacyCommand(command);
  return normalized === 'code-review-graph status || true'
    || normalized === 'code-review-graph update --skip-flows || true'
    || normalized === 'cat >/dev/null || true; code-review-graph status || true'
    || normalized === 'cat >/dev/null || true; code-review-graph update --skip-flows || true';
}

function cleanLegacyCrgHooks(home = codexHome()) {
  const target = path.join(home, 'hooks.json');
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.hooks) return false;
  let changed = false;
  for (const eventName of Object.keys(parsed.hooks)) {
    if (!Array.isArray(parsed.hooks[eventName])) continue;
    const next = [];
    for (const group of parsed.hooks[eventName]) {
      if (!group || !Array.isArray(group.hooks)) {
        next.push(group);
        continue;
      }
      const hooks = group.hooks.filter((hook) => !isLegacyCrgCommand(hook && hook.command));
      if (hooks.length !== group.hooks.length) changed = true;
      if (hooks.length > 0) next.push({ ...group, hooks });
    }
    if (next.length !== parsed.hooks[eventName].length) {
      changed = true;
      if (next.length === 0) delete parsed.hooks[eventName];
      else parsed.hooks[eventName] = next;
    }
  }
  if (!changed) return false;
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return true;
}

/**
 * Remove legacy CRG lines only from the Git hook path effective for the current repository.
 * @example cleanLegacyCrgGitHook(process.cwd())
 */
function cleanLegacyCrgGitHook(cwd) {
  const root = repoRoot(cwd);
  if (!root) return false;
  const target = gitPath(root, 'hooks/pre-commit');
  if (!target) return false;
  let content = '';
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return false;
  }
  if (!content.includes('Installed by code-review-graph')) return false;
  if (!content.includes('code-review-graph update')) return false;
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) =>
    !line.includes('Installed by code-review-graph')
    && normalizeLegacyCommand(line) !== 'code-review-graph update || true'
  );
  const meaningful = kept.filter((line) => {
    const trimmed = line.trim();
    return trimmed && trimmed !== '#!/bin/sh' && trimmed !== '#!/usr/bin/env sh';
  });
  try {
    if (meaningful.length === 0) {
      fs.unlinkSync(target);
    } else {
      fs.writeFileSync(target, `${kept.join('\n').replace(/\s+$/, '')}\n`, 'utf8');
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Check whether a same-name global MCP uses an old uvx launcher with ambiguous ownership.
 * @example isLegacyUvxCrgMcpConfig({ command: 'uvx', args: ['code-review-graph', 'serve'] })
 */
function isLegacyUvxCrgMcpConfig(config) {
  if (!config || typeof config !== 'object') return false;
  const transport = mcpTransport(config);
  const type = typeof config.transport === 'string'
    ? config.transport
    : (transport.type || config.type || config.transport_type || 'stdio');
  if (String(type).toLowerCase() !== 'stdio') return false;
  const command = String(transport.command || config.command || '');
  const args = transport.args || config.args;
  if (!Array.isArray(args)) return false;
  const normalizedArgs = JSON.stringify(args);
  return path.basename(command).toLowerCase() === 'uvx'
    && normalizedArgs === JSON.stringify(['code-review-graph', 'serve']);
}

/**
 * Check whether a path proves that a same-name global MCP belongs to the old plugin-private runtime.
 * @example isPluginManagedLegacyCrgMcpConfig({ command: '/home/me/.codex/plugins/data/codemap-boost-codex-shop/crg-runtime/bin/code-review-graph', args: ['serve'] })
 */
function isPluginManagedLegacyCrgMcpConfig(config) {
  if (!config || typeof config !== 'object') return false;
  const transport = mcpTransport(config);
  const type = typeof config.transport === 'string'
    ? config.transport
    : (transport.type || config.type || config.transport_type || 'stdio');
  if (String(type).toLowerCase() !== 'stdio') return false;
  const command = String(transport.command || config.command || '').replace(/\\/g, '/');
  const args = transport.args || config.args;
  if (!Array.isArray(args)) return false;
  return /\/plugins\/data\/codemap-boost-codex(?:-[^/]+)?\/crg-runtime\/(?:Scripts|bin)\/code-review-graph(?:\.exe)?$/i.test(command)
    && JSON.stringify(args) === JSON.stringify(['serve']);
}

/**
 * Remove an old global registration only when its private-runtime path proves plugin ownership.
 * @example removeLegacyCrgMcp({ cwd: process.cwd() })
 */
function removeLegacyCrgMcp(options = {}) {
  const codexCommand = options.codexCommand
    || (options.spawnSync ? 'codex' : resolveCodexCommand(options));
  if (!codexCommand) {
    return {
      ok: true,
      changed: false,
      skipped: true,
      diagnostic: 'No executable standalone Codex CLI was found, so old global MCP overrides cannot be checked; the native plugin MCP launcher itself does not depend on the CLI.',
    };
  }
  const commandOptions = { ...options, codexCommand };
  const getResult = runCodexMcp(['mcp', 'get', 'code-review-graph', '--json'], commandOptions);
  const output = `${getResult && getResult.stdout ? getResult.stdout : ''}\n${getResult && getResult.stderr ? getResult.stderr : ''}`;
  const config = parseMcpJson(output);
  if (!isPluginManagedLegacyCrgMcpConfig(config)) return { ok: true, changed: false };
  const removeResult = runCodexMcp(['mcp', 'remove', 'code-review-graph'], commandOptions);
  if (removeResult && !removeResult.error && removeResult.status === 0) {
    return { ok: true, changed: true };
  }
  return {
    ok: false,
    changed: false,
    diagnostic: 'Could not remove the old global code-review-graph registration. It shadows the native plugin MCP; run setup to repair it automatically.',
  };
}

/**
 * Run the legacy MCP migration until it has checked a real Codex CLI once, then never again.
 * SessionStart fires on startup, resume, clear and compact; repeating CLI probes there only adds latency.
 * When no usable CLI exists the check is skipped and retried at most once a day, so an unrunnable desktop-app
 * entry on PATH does not cost a failed `codex --version` probe at every session start.
 * @example removeLegacyCrgMcpOnce({ cwd: process.cwd() })
 */
function removeLegacyCrgMcpOnce(options = {}) {
  const marker = markerPath(LEGACY_MCP_CHECKED_MARKER);
  const now = (options.now || Date.now)();
  try {
    const recorded = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (recorded && (recorded.status === 'checked'
        || (recorded.status === 'skipped' && now - recorded.at < LEGACY_MCP_RETRY_MS))) {
      return { ok: true, changed: false, cached: true };
    }
  } catch (_) {} // missing or unreadable marker: run the check
  const result = (options.removeLegacyCrgMcp || removeLegacyCrgMcp)(options);
  // A failed removal (ok: false) is never recorded, so it is retried at the next session start.
  if (result.ok) writeMarker(LEGACY_MCP_CHECKED_MARKER, JSON.stringify({ status: result.skipped ? 'skipped' : 'checked', at: now }));
  return result;
}

module.exports = {
  LEGACY_MCP_CHECKED_MARKER,
  isLegacyCrgCommand,
  cleanLegacyCrgHooks,
  cleanLegacyCrgGitHook,
  isLegacyUvxCrgMcpConfig,
  isPluginManagedLegacyCrgMcpConfig,
  removeLegacyCrgMcp,
  removeLegacyCrgMcpOnce,
};
