#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function pluginRoot() {
  return process.env.PLUGIN_ROOT
    ? path.resolve(process.env.PLUGIN_ROOT)
    : path.resolve(__dirname, '..', '..');
}

function codexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function pluginData() {
  return process.env.PLUGIN_DATA
    ? path.resolve(process.env.PLUGIN_DATA)
    : path.join(codexHome(), 'plugins', 'data', 'system-proxy-codex');
}

/**
 * Return Python 3 candidates for this platform, preferring explicit configuration.
 * @example pythonCandidates({ platform: 'darwin', environment: {} })
 */
function pythonCandidates(options = {}) {
  const environment = options.environment || process.env;
  if (environment.SYSTEM_PROXY_PYTHON) {
    const prefix = String(environment.SYSTEM_PROXY_PYTHON_ARGS || '').trim().split(/\s+/).filter(Boolean);
    return [{ command: environment.SYSTEM_PROXY_PYTHON, prefix }];
  }
  const candidates = [
    { command: 'python3', prefix: [] },
    { command: 'python', prefix: [] },
  ];
  if ((options.platform || process.platform) === 'win32') {
    candidates.push({ command: 'py', prefix: ['-3'] });
  }
  return candidates;
}

/**
 * Select the first supported Python; older versions do not block later candidates.
 * @example findPython({ candidates: [{ command: 'python3', prefix: [] }] })
 */
function findPython(options = {}) {
  const candidates = options.candidates || pythonCandidates(options);
  const spawn = options.spawnSync || spawnSync;
  for (const candidate of candidates) {
    const probe = spawn(candidate.command, [...candidate.prefix, '--version'], {
      encoding: 'utf8',
      windowsHide: (options.platform || process.platform) === 'win32',
      timeout: 5000,
    });
    if (probe.error || probe.status !== 0) continue;
    const version = `${probe.stdout || ''} ${probe.stderr || ''}`.match(/Python\s+(\d+)\.(\d+)/i);
    if (version && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 10))) {
      return candidate;
    }
  }
  return null;
}

function hookMessage(message) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: message,
    },
  }));
}

/**
 * Run a command with the detected Python, preserving caller standard streams.
 * @example runPythonCommand(['-m', 'unittest'])
 */
function runPythonCommand(args) {
  const python = findPython();
  if (!python) {
    process.stderr.write('System Proxy for Codex requires Python 3.10 or later.\n');
    return 2;
  }
  const child = spawnSync(python.command, [...python.prefix, ...args], {
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
    stdio: 'inherit',
    windowsHide: process.platform === 'win32',
  });
  if (child.error) {
    process.stderr.write(`System Proxy for Codex could not start Python: ${child.error.message}\n`);
    return 2;
  }
  return Number.isInteger(child.status) ? child.status : 2;
}

/**
 * Dispatch hook mode or cross-platform Python command mode.
 * @example main()
 */
function main() {
  const hook = process.argv[2];
  if (hook === '--exec') {
    process.exitCode = runPythonCommand(process.argv.slice(3));
    return;
  }
  if (hook !== 'session_start') return;
  const python = findPython();
  if (!python) {
    hookMessage('System Proxy for Codex requires Python 3.10 or later.');
    return;
  }
  const root = pluginRoot();
  const data = pluginData();
  try { fs.mkdirSync(data, { recursive: true }); } catch (_) {}
  let input = Buffer.alloc(0);
  try { input = fs.readFileSync(0); } catch (_) {}
  const child = spawnSync(
    python.command,
    [...python.prefix, path.join(root, 'scripts', 'session_start.py')],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PLUGIN_ROOT: root,
        PLUGIN_DATA: data,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      input,
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
      timeout: 40000,
    }
  );
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error || child.status !== 0) {
    hookMessage(`System Proxy for Codex automatic setup did not complete: ${child.error
      ? child.error.message : `Python exit code ${child.status}`}`);
    return;
  }
  if (child.stdout) process.stdout.write(child.stdout);
}

if (require.main === module) main();

module.exports = { findPython, main, pythonCandidates, runPythonCommand };
