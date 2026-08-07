'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const setup = path.join(pluginRoot, 'scripts', 'setup.cjs');

function writeFakeCodex(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const file = path.join(binDir, 'codex.cmd');
    fs.writeFileSync(file, [
      '@echo off',
      'echo %*>>"%CODEMAP_TEST_MCP_LOG%"',
      'if defined CODEMAP_TEST_CODEX_BROKEN exit /b 1',
      'if "%1"=="--version" echo codex-cli 0.146.1 & exit /b 0',
      'if "%2"=="get" if defined CODEMAP_TEST_MCP_BAD_CWD echo {"name":"code-review-graph","enabled":true,"startup_timeout_sec":100,"transport":{"type":"stdio","command":"node","args":["scripts/mcp-server.cjs"],"cwd":"C:\\fixed"}} & exit /b 0',
      'if "%2"=="get" if defined CODEMAP_TEST_CRG_JSON_COMMAND echo {"name":"code-review-graph","enabled":true,"startup_timeout_sec":100,"transport":{"type":"stdio","command":"node","args":["scripts/mcp-server.cjs"],"cwd":"%CODEMAP_TEST_PLUGIN_ROOT_JSON%"}} & exit /b 0',
      'if "%2"=="get" echo {"name":"code-review-graph","enabled":true,"transport":{"type":"stdio","command":"uvx","args":["code-review-graph","serve"],"cwd":null}} & exit /b 0',
      'exit /b 1',
      '',
    ].join('\r\n'), 'utf8');
    return file;
  }
  const file = path.join(binDir, 'codex');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'echo "$@" >> "$CODEMAP_TEST_MCP_LOG"',
    'if [ -n "$CODEMAP_TEST_CODEX_BROKEN" ]; then exit 1; fi',
    'if [ "$1" = "--version" ]; then echo "codex-cli 0.146.1"; exit 0; fi',
    'if [ "$2" = "get" ] && [ -n "$CODEMAP_TEST_MCP_BAD_CWD" ]; then',
    '  printf \'{"name":"code-review-graph","enabled":true,"startup_timeout_sec":100,"transport":{"type":"stdio","command":"node","args":["scripts/mcp-server.cjs"],"cwd":"/fixed"}}\\n\'',
    '  exit 0',
    'fi',
    'if [ "$2" = "get" ] && [ -n "$CODEMAP_TEST_CRG_COMMAND" ]; then',
    '  printf \'{"name":"code-review-graph","enabled":true,"startup_timeout_sec":100,"transport":{"type":"stdio","command":"node","args":["scripts/mcp-server.cjs"],"cwd":"%s"}}\\n\' "$CODEMAP_TEST_PLUGIN_ROOT"',
    '  exit 0',
    'fi',
    'if [ "$2" = "get" ]; then',
    '  echo \'{"name":"code-review-graph","enabled":true,"transport":{"type":"stdio","command":"uvx","args":["code-review-graph","serve"],"cwd":null}}\'' ,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(file, 0o755);
  return file;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-doctor-'));
try {
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'codex-home');
  const data = path.join(tmp, 'plugin-data');
  const bin = path.join(tmp, 'bin');
  const mcpLog = path.join(tmp, 'mcp.log');
  const spawnShim = path.join(tmp, 'spawn-shim.cjs');
  fs.mkdirSync(repo, { recursive: true });
  const fakeCodex = writeFakeCodex(bin);
  fs.writeFileSync(spawnShim, [
    "'use strict';",
    "const childProcess = require('child_process');",
    'const originalSpawnSync = childProcess.spawnSync;',
    'childProcess.spawnSync = function patchedSpawnSync(command, args, options) {',
    "  if (String(command).includes('crg-runtime')) return { status: 0, stdout: 'ok\\n', stderr: '', error: undefined };",
    '  return originalSpawnSync.call(this, command, args, options);',
    '};',
    '',
  ].join('\n'), 'utf8');

  const result = spawnSync(process.execPath, [setup, '--doctor'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: home,
      PLUGIN_DATA: data,
      CODEMAP_TEST_MCP_LOG: mcpLog,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
    windowsHide: process.platform === 'win32',
  });

  assert.strictEqual(result.status, 1, result.stderr);
  assert.match(result.stdout, /CodeMap Boost doctor/);
  assert.match(result.stdout, /Codex CLI:\s+PASS/);
  assert.match(result.stdout, /MCP 原生配置:\s+PASS/);
  assert.match(result.stdout, /Codex MCP 解析:\s+FAIL/);
  assert.match(result.stdout, /同名全局覆盖:\s+FAIL/);
  assert.match(result.stdout, /uvx.*无法确认|用户确认/);
  assert.match(result.stdout, /当前任务工具:\s+UNKNOWN/);
  assert.match(result.stdout, /只读诊断/);
  assert.deepStrictEqual(fs.existsSync(data) ? fs.readdirSync(data) : [], [], '--doctor must not write plugin data');
  const calls = fs.readFileSync(mcpLog, 'utf8');
  assert.match(calls, /mcp get code-review-graph --json/);
  assert.doesNotMatch(calls, /mcp (add|remove)/, '--doctor must not repair MCP registration');

  const managedDir = path.join(data, 'crg-runtime', process.platform === 'win32' ? 'Scripts' : 'bin');
  const managedCommand = path.join(managedDir, process.platform === 'win32' ? 'code-review-graph.exe' : 'code-review-graph');
  const managedPython = path.join(managedDir, process.platform === 'win32' ? 'python.exe' : 'python');
  fs.mkdirSync(managedDir, { recursive: true });
  fs.writeFileSync(managedCommand, '', 'utf8');
  fs.writeFileSync(managedPython, '', 'utf8');
  const gitInit = spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8', windowsHide: process.platform === 'win32' });
  assert.strictEqual(gitInit.status, 0, gitInit.stderr);
  fs.mkdirSync(path.join(repo, '.code-review-graph'), { recursive: true });
  const before = fs.readdirSync(data, { recursive: true }).sort();

  const healthy = spawnSync(process.execPath, [setup, '--doctor'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: home,
      PLUGIN_DATA: data,
      CODEMAP_TEST_MCP_LOG: mcpLog,
      CODEMAP_TEST_CRG_COMMAND: managedCommand,
      CODEMAP_TEST_CRG_JSON_COMMAND: managedCommand.replace(/\\/g, '\\\\'),
      CODEMAP_TEST_PLUGIN_ROOT: pluginRoot,
      CODEMAP_TEST_PLUGIN_ROOT_JSON: pluginRoot.replace(/\\/g, '\\\\'),
      NODE_OPTIONS: `--require=${spawnShim}`,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
    windowsHide: process.platform === 'win32',
  });

  assert.strictEqual(healthy.status, 0, `${healthy.stderr}\n${healthy.stdout}`);
  assert.match(healthy.stdout, /私有运行时:\s+PASS/);
  assert.match(healthy.stdout, /MCP 原生配置:\s+PASS/);
  assert.match(healthy.stdout, /启动超时 100 秒/);
  assert.match(healthy.stdout, /Codex MCP 解析:\s+PASS/);
  assert.match(healthy.stdout, /同名全局覆盖:\s+PASS/);
  assert.match(healthy.stdout, /项目图谱:\s+PASS/);
  assert.match(healthy.stdout, /最终状态:\s+READY/);
  assert.deepStrictEqual(fs.readdirSync(data, { recursive: true }).sort(), before, '--doctor stays read-only when healthy');

  const noCli = spawnSync(process.execPath, [setup, '--doctor'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: home,
      PLUGIN_DATA: data,
      CODEMAP_BOOST_CODEX_CLI: `${fakeCodex}.missing`,
      NODE_OPTIONS: `--require=${spawnShim}`,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
    windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(noCli.status, 0, `${noCli.stderr}\n${noCli.stdout}`);
  assert.match(noCli.stdout, /Codex CLI:\s+WARN/);
  assert.match(noCli.stdout, /Codex MCP 解析:\s+UNKNOWN/);
  assert.match(noCli.stdout, /同名全局覆盖:\s+UNKNOWN/);
  assert.match(noCli.stdout, /最终状态:\s+READY/);

  const badMcp = spawnSync(process.execPath, [setup, '--doctor'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: home,
      PLUGIN_DATA: data,
      CODEMAP_TEST_MCP_LOG: mcpLog,
      CODEMAP_TEST_CRG_COMMAND: managedCommand,
      CODEMAP_TEST_CRG_JSON_COMMAND: managedCommand.replace(/\\/g, '\\\\'),
      CODEMAP_TEST_PLUGIN_ROOT: pluginRoot,
      CODEMAP_TEST_PLUGIN_ROOT_JSON: pluginRoot.replace(/\\/g, '\\\\'),
      CODEMAP_TEST_MCP_BAD_CWD: '1',
      NODE_OPTIONS: `--require=${spawnShim}`,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
    windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(badMcp.status, 1, badMcp.stderr);
  assert.match(badMcp.stdout, /同名全局覆盖:\s+FAIL/);
  assert.match(badMcp.stdout, /Codex MCP 解析:\s+FAIL/);
  assert.match(badMcp.stdout, /用户自定义同名 MCP/);

  const nonRepo = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(nonRepo, { recursive: true });
  const wrongDirectory = spawnSync(process.execPath, [setup, '--doctor'], {
    cwd: nonRepo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: home,
      PLUGIN_DATA: data,
      CODEMAP_TEST_MCP_LOG: mcpLog,
      CODEMAP_TEST_CRG_COMMAND: managedCommand,
      CODEMAP_TEST_CRG_JSON_COMMAND: managedCommand.replace(/\\/g, '\\\\'),
      CODEMAP_TEST_PLUGIN_ROOT: pluginRoot,
      CODEMAP_TEST_PLUGIN_ROOT_JSON: pluginRoot.replace(/\\/g, '\\\\'),
      NODE_OPTIONS: `--require=${spawnShim}`,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
    windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(wrongDirectory.status, 1, wrongDirectory.stderr);
  assert.match(wrongDirectory.stdout, /最终状态:\s+NEEDS_PROJECT/);
  assert.match(wrongDirectory.stdout, /切换到目标 Git 仓库/);

  fs.rmSync(path.join(repo, '.code-review-graph'), { recursive: true, force: true });
  const brokenCodex = spawnSync(process.execPath, [setup, '--doctor'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: home,
      PLUGIN_DATA: data,
      CODEMAP_TEST_MCP_LOG: mcpLog,
      CODEMAP_TEST_CRG_COMMAND: managedCommand,
      CODEMAP_TEST_CRG_JSON_COMMAND: managedCommand.replace(/\\/g, '\\\\'),
      CODEMAP_TEST_CODEX_BROKEN: '1',
      CODEMAP_BOOST_CODEX_CLI: fakeCodex,
      NODE_OPTIONS: `--require=${spawnShim}`,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
    windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(brokenCodex.status, 1, brokenCodex.stderr);
  assert.match(brokenCodex.stdout, /Codex CLI:\s+WARN/);
  assert.match(brokenCodex.stdout, /最终状态:\s+NEEDS_BUILD/);
  assert.doesNotMatch(brokenCodex.stdout, /最终状态:\s+NEEDS_REPAIR/);
  assert.doesNotMatch(brokenCodex.stdout, /修复 MCP|重建私有运行时|MCP 已就绪/);

  console.log('doctor.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
