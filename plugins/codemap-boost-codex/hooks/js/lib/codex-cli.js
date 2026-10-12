'use strict';

// Adapter for the standalone Codex CLI: locate a runnable executable, run its MCP subcommands, and read its JSON.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { MCP_STARTUP_TIMEOUT_SEC } = require('./bootstrap');

function stripAnsi(value) {
  return String(value || '')
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/[\u001b\u005d].*?(?:\u0007|\u001b\\)/g, '');
}

function parseMcpJson(value) {
  if (value && typeof value === 'object') return value;
  const text = stripAnsi(value);
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    let depth = 0;
    let quote = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quote = false;
        continue;
      }
      if (char === '"') {
        quote = true;
        continue;
      }
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') depth -= 1;
      if (depth !== 0) continue;
      try { return JSON.parse(text.slice(start, index + 1)); } catch (_) { break; }
    }
  }
  return null;
}

function mcpTransport(config) {
  if (!config || typeof config !== 'object') return {};
  const transport = config.transport;
  if (transport && typeof transport === 'object') return transport;
  return config;
}

/**
 * Check whether the current MCP configuration uses the plugin’s bundled cross-platform launcher.
 * @example isNativeCrgMcpConfig({ command: 'node', args: ['scripts/mcp-server.cjs'], cwd: '.', startup_timeout_sec: 600 }, { allowRelativeCwd: true })
 */
function isNativeCrgMcpConfig(config, options = {}) {
  if (!config || typeof config !== 'object') return false;
  if (config.enabled === false && !options.allowDisabled) return false;
  const transport = mcpTransport(config);
  const type = typeof config.transport === 'string'
    ? config.transport
    : (transport.type || config.type || config.transport_type || 'stdio');
  const command = String(transport.command || config.command || '');
  const args = transport.args || config.args;
  const cwd = String(transport.cwd ?? config.cwd ?? '');
  const timeout = Number(config.startup_timeout_sec ?? config.startupTimeoutSec);
  let cwdOk = false;
  if (options.allowRelativeCwd) cwdOk = cwd === '.';
  else if (options.expectedCwd && cwd) {
    const actual = path.resolve(cwd);
    const expected = path.resolve(options.expectedCwd);
    cwdOk = process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  }
  return String(type).toLowerCase() === 'stdio'
    && ['node', 'node.exe'].includes(path.basename(command).toLowerCase())
    && Array.isArray(args)
    && JSON.stringify(args) === JSON.stringify(['scripts/mcp-server.cjs'])
    && cwdOk
    && Number.isFinite(timeout)
    && timeout === MCP_STARTUP_TIMEOUT_SEC;
}

/**
 * Run a resolved Codex CLI; Windows batch entry points must launch through cmd.exe.
 * @example runCodexCommand('codex', ['--version'])
 */
function runCodexCommand(command, args, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const env = options.env || process.env;
  const useCmdShim = process.platform === 'win32'
    && !options.spawnSync
    && /\.(?:cmd|bat)$/i.test(command);
  const executable = useCmdShim ? (env.ComSpec || process.env.ComSpec || 'cmd.exe') : command;
  const commandEnv = useCmdShim ? { ...env, CODEMAP_BOOST_CODEX_COMMAND: command } : env;
  if (useCmdShim) {
    args.forEach((arg, index) => {
      commandEnv[`CODEMAP_BOOST_CODEX_ARG_${index}`] = String(arg);
    });
  }
  const commandArgRefs = args.map((arg, index) => {
    const ref = `%CODEMAP_BOOST_CODEX_ARG_${index}%`;
    return /^[A-Za-z0-9_./:\\-]+$/.test(String(arg)) ? ref : `"${ref}"`;
  });
  const commandArgs = useCmdShim
    ? [
        '/d',
        '/v:off',
        '/s',
        '/c',
        `""%CODEMAP_BOOST_CODEX_COMMAND%" ${commandArgRefs.join(' ')}"`,
      ]
    : args;
  try {
    return spawn(executable, commandArgs, {
      cwd: options.cwd || process.cwd(),
      env: commandEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout || 30000,
      windowsHide: process.platform === 'win32',
      windowsVerbatimArguments: useCmdShim,
    });
  } catch (error) {
    return { status: null, error, stdout: '', stderr: '' };
  }
}

/**
 * Probe Codex CLI candidates from PATH one by one, skipping desktop-app entries that exist but cannot execute.
 * @example resolveCodexCommand({ cwd: process.cwd() })
 */
function resolveCodexCommand(options = {}) {
  const env = options.env || process.env;
  const explicit = String(env.CODEMAP_BOOST_CODEX_CLI || '').trim();
  const candidates = [];
  if (explicit) {
    candidates.push(explicit);
  } else {
    const suffixes = process.platform === 'win32'
      ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
    const names = process.platform === 'win32'
      ? [...suffixes.map((suffix) => `codex${suffix.toLowerCase()}`), 'codex']
      : ['codex'];
    for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const name of names) {
        const candidate = path.resolve(directory.replace(/^"|"$/g, ''), name);
        try {
          if (fs.statSync(candidate).isFile()) candidates.push(candidate);
        } catch (_) {}
      }
    }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    const probe = runCodexCommand(candidate, ['--version'], { ...options, env, timeout: 10000 });
    if (probe && !probe.error && probe.status === 0) return candidate;
  }
  return null;
}

/**
 * Run Codex MCP subcommands through a verified CLI; tests may inject spawnSync.
 * @example runCodexMcp(['mcp', 'get', 'code-review-graph', '--json'])
 */
function runCodexMcp(args, options = {}) {
  const command = options.codexCommand
    || (options.spawnSync ? 'codex' : resolveCodexCommand(options));
  if (!command) {
    const error = new Error('Codex CLI is unavailable');
    error.code = 'ENOENT';
    return { status: null, error, stdout: '', stderr: '', available: false };
  }
  return runCodexCommand(command, args, options);
}

module.exports = {
  parseMcpJson,
  mcpTransport,
  isNativeCrgMcpConfig,
  runCodexCommand,
  resolveCodexCommand,
  runCodexMcp,
};
