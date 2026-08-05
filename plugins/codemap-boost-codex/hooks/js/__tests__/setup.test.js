'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { crgRuntimePaths } = require('../lib/bootstrap');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const setup = path.join(pluginRoot, 'scripts', 'setup.cjs');

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFakeCrg(binDir) {
  mkdirp(binDir);
  if (process.platform === 'win32') {
    const file = path.join(binDir, 'code-review-graph.cmd');
    fs.writeFileSync(file, [
      '@echo off',
      'echo %*>>"%CODEMAP_TEST_LOG%"',
      'exit /b 0',
      '',
    ].join('\r\n'), 'utf8');
    return file;
  }
  const file = path.join(binDir, 'code-review-graph');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'echo "$@" >> "$CODEMAP_TEST_LOG"',
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(file, 0o755);
  return file;
}

function writeFakeCodex(binDir) {
  mkdirp(binDir);
  if (process.platform === 'win32') {
    const file = path.join(binDir, 'codex.cmd');
    fs.writeFileSync(file, [
      '@echo off',
      'echo %*>>"%CODEMAP_TEST_MCP_LOG%"',
      'if "%2"=="get" if exist "%CODEMAP_TEST_MCP_OK%" echo {"name":"code-review-graph","enabled":true,"transport":{"type":"stdio","command":"%CODEMAP_TEST_CRG_JSON_COMMAND%","args":["serve"],"cwd":null}} & exit /b 0',
      'if "%2"=="get" exit /b 1',
      'if "%2"=="remove" exit /b 1',
      'if "%2"=="add" echo ok>"%CODEMAP_TEST_MCP_OK%" & exit /b 0',
      'exit /b 1',
      '',
    ].join('\r\n'), 'utf8');
    return file;
  }
  const file = path.join(binDir, 'codex');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'echo "$@" >> "$CODEMAP_TEST_MCP_LOG"',
    'if [ "$2" = "get" ] && [ -f "$CODEMAP_TEST_MCP_OK" ]; then',
    '  printf \'{"name":"code-review-graph","enabled":true,"transport":{"type":"stdio","command":"%s","args":["serve"],"cwd":null}}\\n\' "$CODEMAP_TEST_CRG_COMMAND"',
    '  exit 0',
    'fi',
    'if [ "$2" = "get" ]; then exit 1; fi',
    'if [ "$2" = "remove" ]; then exit 1; fi',
    'if [ "$2" = "add" ]; then touch "$CODEMAP_TEST_MCP_OK"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(file, 0o755);
  return file;
}

function sh(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(result.status, 0, result.stderr);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-setup-'));
try {
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'codex-home');
  const data = path.join(tmp, 'plugin-data');
  const bin = path.join(tmp, 'bin');
  const log = path.join(tmp, 'crg.log');
  const mcpLog = path.join(tmp, 'mcp.log');
  const mcpOk = path.join(tmp, 'mcp.ok');
  mkdirp(repo);
  sh(['init'], repo);
  writeFakeCrg(bin);
  writeFakeCodex(bin);
  mkdirp(data);
  const managed = crgRuntimePaths({ runtimeDir: path.join(data, 'crg-runtime') });
  mkdirp(path.dirname(managed.command));
  fs.writeFileSync(managed.command, '', 'utf8');
  fs.writeFileSync(path.join(data, '.codemap-bootstrap-failed'), '旧版本失败状态\n', 'utf8');

  const result = spawnSync(process.execPath, [setup, '--skip-install'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: home,
      PLUGIN_DATA: data,
      CODEMAP_TEST_LOG: log,
      CODEMAP_TEST_MCP_LOG: mcpLog,
      CODEMAP_TEST_MCP_OK: mcpOk,
      CODEMAP_TEST_CRG_COMMAND: managed.command,
      CODEMAP_TEST_CRG_JSON_COMMAND: managed.command.replace(/\\/g, '\\\\'),
      CODEMAP_BOOST_ASSUME_CRG: '1',
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
    windowsHide: process.platform === 'win32',
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(managed.command), 'setup reports the plugin-owned runtime path');
  assert.ok(fs.existsSync(path.join(data, '.codemap-boost-enabled')), 'setup writes enable marker');
  assert.ok(!fs.existsSync(path.join(data, '.codemap-bootstrap-failed')), 'successful setup clears a stale bootstrap failure');
  assert.ok(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8').includes('codemap-boost-codex:start'), 'setup writes AGENTS block');
  assert.ok(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8').includes('.code-review-graph/'), 'setup updates project gitignore');
  const mcpCalls = fs.readFileSync(mcpLog, 'utf8');
  assert.ok(mcpCalls.includes('mcp get code-review-graph --json'), 'setup checks the existing MCP config');
  const normalizedMcpCalls = mcpCalls.replace(/"/g, '');
  assert.ok(
    normalizedMcpCalls.includes(`mcp add code-review-graph -- ${managed.command} serve`),
    `setup registers the plugin-owned runtime\nMCP calls:\n${mcpCalls}`
  );
  assert.ok(!fs.existsSync(log), 'setup without --build does not start graph build');

  const brokenData = path.join(tmp, 'broken-plugin-data');
  const broken = spawnSync(process.execPath, [setup, '--skip-install'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: home,
      PLUGIN_DATA: brokenData,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
    windowsHide: process.platform === 'win32',
  });
  assert.notStrictEqual(broken.status, 0, 'skip-install rejects a missing managed runtime');
  assert.ok(fs.existsSync(path.join(brokenData, '.crg-install-failed')), 'skip-install failure writes a diagnostic marker');

  console.log('setup.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
