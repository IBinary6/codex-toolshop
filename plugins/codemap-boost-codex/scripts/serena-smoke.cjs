'use strict';

// 真实 Serena MCP 烟测：默认冷装到临时 PLUGIN_DATA；--data-dir 可复用已下载的私有运行时。
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('child_process');
const {
  SERENA_MCP_ARGS,
  ensureSerena,
  serenaLaunchEnv,
  serenaRuntimePaths,
} = require('../hooks/js/lib/serena-runtime');

const pluginRoot = path.resolve(__dirname, '..');
const launcher = path.join(pluginRoot, 'scripts', 'serena-server.cjs');
const STARTUP_TIMEOUT_MS = 600000;
const LSP_TIMEOUT_MS = 180000;

function parseArgs(argv) {
  const result = { dataDir: '', keep: false, version: '', sessionTestsOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--data-dir') result.dataDir = path.resolve(argv[++index] || '');
    else if (argv[index] === '--runtime-version') result.version = argv[++index] || '';
    else if (argv[index] === '--keep-data') result.keep = true;
    else if (argv[index] === '--session-tests-only') result.sessionTestsOnly = true;
    else throw new Error(`未知参数：${argv[index]}`);
  }
  return result;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function toolByName(tools, name) {
  const tool = (tools.tools || []).find((item) => item.name === name);
  assert.ok(tool, `Serena exposes ${name}`);
  return tool;
}

function assertToolSuccess(label, result) {
  assert.ok(result && !result.isError, `${label} returned an MCP tool error: ${JSON.stringify(result)}`);
  const text = (result.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  assert.doesNotMatch(text, /(?:^|[\s:{\[])error(?:[\s:}\],]|$)/i, `${label} reported an error: ${text}`);
}

function contentJson(result) {
  const values = [];
  for (const item of result.content || []) {
    if (item.type !== 'text' || typeof item.text !== 'string') continue;
    try { values.push(JSON.parse(item.text)); } catch (_) {}
  }
  return values;
}

function flatten(value, out = []) {
  if (Array.isArray(value)) for (const item of value) flatten(item, out);
  else if (value && typeof value === 'object') {
    out.push(value);
    for (const item of Object.values(value)) flatten(item, out);
  }
  return out;
}

function findSymbolArguments(tool, name = 'smokeSymbol', relativePath = 'src/sample.ts') {
  const properties = (tool.inputSchema && tool.inputSchema.properties) || {};
  const args = { include_body: true };
  if (Object.hasOwn(properties, 'name_path_pattern')) args.name_path_pattern = name;
  else if (Object.hasOwn(properties, 'name_path')) args.name_path = name;
  else throw new Error(`find_symbol schema does not expose a name-path parameter: ${JSON.stringify(properties)}`);
  if (Object.hasOwn(properties, 'relative_path')) args.relative_path = relativePath;
  return args;
}

function symbolNodes(result) { return contentJson(result).flatMap((value) => flatten(value)); }

function assertCppSymbol(result, name, present = true) {
  assertToolSuccess(`find_symbol ${name}`, result);
  const matched = symbolNodes(result).some(node => String(node.name_path || node.name || '') === name);
  assert.strictEqual(matched, present, `${name} presence must be ${present}: ${JSON.stringify(result.content)}`);
}

function createCppFixture(tempRoot) {
  const root = path.join(tempRoot, 'cpp-fixture');
  fs.mkdirSync(root);
  const files = {
    'sample.h': '#pragma once\nint sharedValue();\n',
    'sample.cpp': '#include "sample.h"\nint sharedValue() { return 42; }\n#if FEATURE_ONE\nint featureOne() { return sharedValue(); }\n#else\nint featureZero() { return sharedValue(); }\n#endif\n',
    'caller.cpp': '#include "sample.h"\nint crossFileCaller() { return sharedValue(); }\n',
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text, 'utf8');
  const digest = () => Object.keys(files).map(name => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'));
  const original = digest();
  const setMacro = value => fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify(
    ['sample.cpp', 'caller.cpp'].map(name => ({ directory: root, file: path.join(root, name),
      arguments: ['clang++', '-std=c++17', `-DFEATURE_ONE=${value}`, '-c', path.join(root, name)] }))), 'utf8');
  setMacro(1);
  return { root, setMacro, assertSourcesUnchanged() { assert.deepStrictEqual(digest(), original, 'compile parameter refresh must not edit fixture sources'); } };
}

function verifySessionConfiguration(dataDir, version) {
  const paths = serenaRuntimePaths({ pluginDataDir: dataDir, version });
  const test = path.join(pluginRoot, 'hooks', 'js', '__tests__', 'test_serena_session.py');
  const result = spawnSync(paths.python, ['-I', '-B', test], {
    cwd: pluginRoot, env: serenaLaunchEnv({ pluginDataDir: dataDir }), encoding: 'utf8',
    timeout: 180000, windowsHide: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, `official Serena session configuration tests failed: ${result.stderr || result.stdout}`);
  process.stdout.write('official Serena session configuration tests PASS\n');
}

function assertSymbolResult(result) {
  assertToolSuccess('find_symbol', result);
  const nodes = contentJson(result).flatMap((value) => flatten(value));
  const matched = nodes.some((node) => {
    const name = String(node.name_path || node.name || node.qualified_name || '');
    const file = String(node.relative_path || node.file_path || node.path || '');
    const body = String(node.body || node.content || node.source || '');
    return /smokeSymbol/.test(name) && /sample\.ts/.test(file) && /smokeSymbol/.test(body);
  });
  assert.ok(matched, `find_symbol content lacks the expected name, path and body: ${JSON.stringify(result.content)}`);
}

/**
 * 通过 Serena 自己的 Click 入口解析启动参数，并截断 transport run；这样断言的是
 * 实际 factory 创建时的有效配置，且不会启动 MCP transport 或自动激活项目。
 */
function verifyFactoryUiState(dataDir, tempRoot, version) {
  const paths = serenaRuntimePaths({ pluginDataDir: dataDir, version });
  const probeHome = path.join(tempRoot, 'factory-ui-probe-home');
  const script = [
    'import json, sys',
    'from unittest.mock import patch',
    'from serena.cli import top_level',
    'from serena.mcp import SerenaMCPFactory',
    'seen = {}',
    'original_create = SerenaMCPFactory.create_mcp_server',
    'def create_checked(self, *args, **kwargs):',
    '    server = original_create(self, *args, **kwargs)',
    '    agent = self.agent',
    '    assert self.project is None, self.project',
    '    config = agent.serena_config',
    "    assert config.web_dashboard is False, config.web_dashboard",
    "    assert config.web_dashboard_open_on_launch is False, config.web_dashboard_open_on_launch",
    "    assert config.gui_log_window is False, config.gui_log_window",
    "    assert getattr(agent, '_dashboard_manager', None) is None",
    "    assert getattr(agent, '_gui_log_viewer', None) is None",
    "    seen.update({'web_dashboard': config.web_dashboard, 'web_dashboard_open_on_launch': config.web_dashboard_open_on_launch, 'gui_log_window': config.gui_log_window, 'dashboard_manager': getattr(agent, '_dashboard_manager', None), 'gui_log_viewer': getattr(agent, '_gui_log_viewer', None), 'project': self.project})",
    '    return server',
    "with patch.object(SerenaMCPFactory, 'create_mcp_server', create_checked):",
    "    with patch('serena.mcp.FastMCP.run', lambda *_args, **_kwargs: None):",
    "        top_level.main(args=json.loads(sys.argv[1]), prog_name='serena', standalone_mode=False)",
    'print(json.dumps(seen))',
  ].join('\n');
  const result = spawnSync(paths.python, ['-I', '-B', '-c', script, JSON.stringify(SERENA_MCP_ARGS)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    windowsHide: process.platform === 'win32',
    env: serenaLaunchEnv({ pluginDataDir: dataDir, serenaHomeDir: probeHome }),
  });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, `factory UI probe failed: ${result.stderr || result.stdout}`);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length, 'factory UI probe must return its effective configuration');
  let state;
  try { state = JSON.parse(lines.at(-1)); } catch (error) {
    throw new Error(`factory UI probe returned invalid JSON: ${result.stdout}\n${error.message}`);
  }
  assert.deepStrictEqual(state, {
    web_dashboard: false,
    web_dashboard_open_on_launch: false,
    gui_log_window: false,
    dashboard_manager: null,
    gui_log_viewer: null,
    project: null,
  }, `factory UI state must remain disabled: ${JSON.stringify(state)}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'serena-smoke-')));
  const dataDir = options.dataDir || path.join(tempRoot, 'plugin-data');
  const fixture = path.join(tempRoot, 'fixture');
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'src', 'sample.ts'), 'export function smokeSymbol(value: string): string { return value; }\n', 'utf8');
  const cpp = createCppFixture(tempRoot);
  // 冷装时先以指定候选 venv 完成健康安装，factory probe 才能验证其真实 CLI 契约。
  assert.ok(ensureSerena({ pluginDataDir: dataDir, version: options.version || undefined }), 'Serena private runtime must install before factory verification');
  if (options.sessionTestsOnly) {
    try { verifySessionConfiguration(dataDir, options.version); }
    finally { if (!options.keep) fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); }
    return;
  }
  verifyFactoryUiState(dataDir, tempRoot, options.version);

  const stderr = [];
  const pending = new Map();
  let sequence = 0;
  let buffer = '';
  const child = spawn(process.execPath, [launcher], {
    cwd: pluginRoot,
    // 烟测负责自身临时数据目录；禁止服务启动后再派生后台更新器与清理竞争。
    env: { ...process.env, PLUGIN_DATA: dataDir, SERENA_HOME: path.join(dataDir, 'ignored-user-home'), CODEMAP_BOOST_DISABLE_RUNTIME_UPDATES: '1', ...(options.version ? { CODEMAP_BOOST_SERENA_RUNTIME_VERSION: options.version } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: process.platform === 'win32',
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (error) { for (const item of pending.values()) item.reject(error); continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        const item = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) item.reject(new Error(JSON.stringify(message.error)));
        else item.resolve(message.result);
      }
    }
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    for (const item of pending.values()) item.reject(new Error(`Serena MCP exited before response: code=${code} signal=${signal}`));
    pending.clear();
    resolve({ code, signal });
  }));
  child.once('error', (error) => { for (const item of pending.values()) item.reject(error); });

  const request = (method, params, timeout = LSP_TIMEOUT_MS) => withTimeout(new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  }), timeout, method);
  const call = (tool, args) => request('tools/call', { name: tool.name, arguments: args });
  let completed = false;

  try {
    const initialize = await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codemap-serena-smoke', version: '1.0' },
    }, STARTUP_TIMEOUT_MS);
    assert.ok(initialize && initialize.capabilities, 'MCP initialize must return capabilities');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const tools = await request('tools/list', {}, STARTUP_TIMEOUT_MS);
    const activate = toolByName(tools, 'activate_project');
    const findSymbol = toolByName(tools, 'find_symbol');
    const activation = await request('tools/call', { name: activate.name, arguments: { project: fixture } });
    assertToolSuccess('activate_project', activation);
    const symbol = await request('tools/call', { name: findSymbol.name, arguments: findSymbolArguments(findSymbol) });
    assertSymbolResult(symbol);
    const configTool = (tools.tools || []).find((tool) => tool.name === 'get_current_config');
    assert.ok(configTool, 'Serena exposes get_current_config for project/context verification');
    const configResult = await request('tools/call', { name: configTool.name, arguments: {} });
    assertToolSuccess('get_current_config', configResult);
    const configText = (configResult.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    assert.match(configText, /Active project:\s*fixture/i, `active fixture project must be reported: ${configText}`);
    assert.match(configText, /Active context:\s*codex/i, `Codex context must be reported: ${configText}`);
    assertToolSuccess('activate C++', await call(activate, { project: cpp.root }));
    const cppTools = await request('tools/list', {});
    const cppFind = toolByName(cppTools, 'find_symbol');
    const referencing = toolByName(cppTools, 'find_referencing_symbols');
    assertCppSymbol(await call(cppFind, findSymbolArguments(cppFind, 'featureOne', 'sample.cpp')), 'featureOne');
    assertCppSymbol(await call(cppFind, findSymbolArguments(cppFind, 'featureZero', 'sample.cpp')), 'featureZero', false);
    assertCppSymbol(await call(cppFind, findSymbolArguments(cppFind, 'crossFileCaller', 'caller.cpp')), 'crossFileCaller');
    const references = await call(referencing, { name_path: 'sharedValue', relative_path: 'sample.cpp' });
    assertToolSuccess('C++ cross-file references', references);
    const referenceText = JSON.stringify(references.content);
    assert.match(referenceText, /caller\.cpp/, 'references must include another translation unit');
    assert.match(referenceText, /crossFileCaller/, 'references must identify the caller symbol');
    assert.match(referenceText, /featureOne/, 'references must include the macro-selected caller');
    cpp.setMacro(0);
    assertCppSymbol(await call(cppFind, findSymbolArguments(cppFind, 'featureZero', 'sample.cpp')), 'featureZero');
    assertCppSymbol(await call(cppFind, findSymbolArguments(cppFind, 'featureOne', 'sample.cpp')), 'featureOne', false);
    cpp.assertSourcesUnchanged();
    assertToolSuccess('return to TypeScript', await call(activate, { project: fixture }));
    const finalTools = await request('tools/list', {});
    const finalFind = toolByName(finalTools, 'find_symbol');
    assertSymbolResult(await call(finalFind, findSymbolArguments(finalFind)));
    completed = true;
  } finally {
    try { child.stdin.end(); } catch (_) {}
    let shutdownConfirmed = false;
    try {
      const exit = await withTimeout(exited, 15000, 'Serena MCP EOF shutdown');
      assert.deepStrictEqual(exit, { code: 0, signal: null }, 'EOF must cleanly stop the owned native backend');
      shutdownConfirmed = true;
      assert.doesNotMatch(stderr.join(''), /session 清理未完成|termination failed|清理失败/, 'owned session cleanup must complete');
      if (completed) verifySessionConfiguration(dataDir, options.version);
    } catch (error) {
      // 超时仍是失败；signal只尝试回收自有frontend，不能把它包装成EOF成功。
      try { child.kill('SIGTERM'); } catch (_) {}
      throw error;
    } finally {
      if (!options.keep && shutdownConfirmed) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      } else console.error(`[serena-smoke] retained fixture=${fixture} pluginData=${dataDir}`);
    }
  }
  assert.ok(completed);
  console.log(`serena smoke PASS (TypeScript/C++ references/macro refresh/switch/EOF; ${options.dataDir ? 'reused runtime' : 'cold install'})`);
}

main().catch((error) => {
  process.stderr.write(`[serena-smoke] ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
