'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
  mkdirp(repo);
  sh(['init'], repo);
  writeFakeCrg(bin);

  const result = spawnSync(process.execPath, [setup, '--skip-install'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: home,
      PLUGIN_DATA: data,
      CODEMAP_TEST_LOG: log,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
    windowsHide: process.platform === 'win32',
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(data, '.codemap-boost-enabled')), 'setup writes enable marker');
  assert.ok(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8').includes('codemap-boost-codex:start'), 'setup writes AGENTS block');
  assert.ok(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8').includes('.code-review-graph/'), 'setup updates project gitignore');
  const calls = fs.readFileSync(log, 'utf8');
  assert.ok(calls.includes('install --platform codex --no-hooks --no-instructions --no-skills --yes'), 'setup registers CRG MCP without third-party assets');
  assert.ok(!calls.includes('build'), 'setup without --build does not start graph build');

  console.log('setup.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
