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

function pythonCandidates() {
  return process.platform === 'win32'
    ? [['python3', []], ['python', []], ['py', ['-3']]]
    : [['python3', []], ['python', []]];
}

function findPython() {
  for (const [command, prefix] of pythonCandidates()) {
    const probe = spawnSync(command, [...prefix, '--version'], {
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
      timeout: 5000,
    });
    if (probe.error || probe.status !== 0) continue;
    const version = `${probe.stdout || ''} ${probe.stderr || ''}`.match(/Python\s+(\d+)\.(\d+)/i);
    if (version && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 10))) {
      return { command, prefix };
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

function main() {
  const hook = process.argv[2];
  if (hook !== 'session_start') return;
  const python = findPython();
  if (!python) {
    hookMessage('System Proxy for Codex 需要 Python 3.10 或更高版本。');
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
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) hookMessage(`System Proxy for Codex 启动 Python 失败：${child.error.message}`);
}

main();
