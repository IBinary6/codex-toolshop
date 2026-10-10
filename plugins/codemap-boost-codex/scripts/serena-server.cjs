'use strict';

const { spawn } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  SERENA_MCP_ARGS,
  doctorSerena,
  ensureSerena,
  readFailureMarker,
  serenaFailureMarker,
  serenaLaunchEnv,
  serenaRuntimePaths,
} = require('../hooks/js/lib/serena-runtime');
const { nodeRuntimeStatus } = require('../hooks/js/lib/runtime');
const { scheduleRuntimeUpdates } = require('../hooks/js/lib/runtime-updates');
const { enterMcpDataDir } = require('./mcp-cwd.cjs');
const { SerenaMcpProxy } = require('./serena-proxy.cjs');
const { killProcessTree } = require('./lazy-mcp.cjs');

function prepareSerenaServer(options = {}) {
  const node = (options.nodeRuntimeStatus || nodeRuntimeStatus)();
  if (!node.ok) return { ok: false, diagnostic: `Node.js ${node.version || '未知'} 不受支持；需要 ${node.requirement}。` };
  const ensure = options.ensureSerena || ensureSerena;
  if (!ensure(options)) {
    return {
      ok: false,
      diagnostic: (options.readFailureMarker || readFailureMarker)(serenaFailureMarker(options))
        || 'Serena 插件私有运行环境安装失败；请运行 --doctor 查看诊断。',
    };
  }
  // 后台更新和当前 stdio 服务隔离；已启动的 Serena venv 不会被原地改写。
  if (!options.ensureSerena || options.scheduleRuntimeUpdates) {
    try { (options.scheduleRuntimeUpdates || scheduleRuntimeUpdates)({ ...options, kinds: ['serena'] }); } catch (_) {}
  }
  const paths = (options.serenaRuntimePaths || serenaRuntimePaths)(options);
  return {
    ok: true,
    command: paths.command,
    args: [...SERENA_MCP_ARGS],
    env: (options.serenaLaunchEnv || serenaLaunchEnv)(options),
    python: paths.python,
  };
}

function sessionCommand(prepared, request, options = {}) {
  if (options.sessionCommand) return Promise.resolve(options.sessionCommand(request));
  return new Promise((resolve, reject) => {
    const child = (options.spawnSession || spawn)(prepared.python,
      ['-I', '-B', path.join(__dirname, 'serena-session.py')], {
        cwd: options.pluginDataDir, env: prepared.env, windowsHide: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child).catch(() => {}).finally(() => reject(new Error('Serena private configuration helper timeout')));
    }, options.sessionTimeoutMs || 45000);
    // helper异常内容可能含配置值，stderr不转发；协议仅返回安全摘要。
    child.stderr.resume();
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Serena private configuration helper failed to start')); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0 || timedOut) throw new Error();
        resolve(JSON.parse(output));
      } catch (_) { reject(new Error('Serena private configuration helper failed')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

async function createSerenaSession(prepared, options) {
  const source = path.resolve(prepared.env.SERENA_HOME || path.join(options.pluginDataDir, 'serena-home'));
  const sessionsPath = path.join(options.pluginDataDir, 'serena-sessions');
  fs.mkdirSync(sessionsPath, { recursive: true });
  // macOS /tmp和用户data alias可能经过目录链接；保存真实父目录作为清理边界。
  const sessions = fs.realpathSync(sessionsPath);
  const home = path.join(sessions, crypto.randomUUID());
  prepared.env = { ...prepared.env, SERENA_HOME: home };
  const result = await sessionCommand(prepared, { command: 'clone', home, source }, options);
  if (!result.ok) throw new Error('Serena private session configuration clone failed');
  // LSP可执行文件由插件稳定home拥有，UUID session不能导致每次重新下载。
  const resources = path.join(source, 'language_servers');
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.symlinkSync(fs.realpathSync(resources), path.join(home, 'language_servers'), process.platform === 'win32' ? 'junction' : 'dir');
  return { home, source, sessions };
}

function cleanupSerenaSession(session, options) {
  const sessions = fs.realpathSync(path.join(options.pluginDataDir, 'serena-sessions'));
  const home = path.resolve(session.home);
  // 只删除本次UUID目录。先unlink自有资源链接，绝不能递归访问稳定LSP目录。
  if ((session.sessions && session.sessions !== sessions) || path.dirname(home) !== sessions
    || fs.lstatSync(home).isSymbolicLink() || fs.realpathSync(home) !== home || !/^[\da-f-]{36}$/i.test(path.basename(home))) {
    throw new Error('Serena session cleanup scope mismatch');
  }
  const resources = path.join(home, 'language_servers');
  if (fs.lstatSync(resources).isSymbolicLink()) fs.unlinkSync(resources);
  else throw new Error('Serena session resource link changed');
  fs.rmSync(home, { recursive: true, force: true });
}

async function runSerenaServer(options = {}) {
  const stderr = options.stderr || process.stderr;
  let prepared;
  try {
    options = enterMcpDataDir(options);
    prepared = prepareSerenaServer(options);
  } catch (error) {
    stderr.write(`[codemap-boost-codex] Serena MCP 数据目录不可用：${error.message}\n`);
    return 1;
  }
  if (!prepared.ok) {
    stderr.write(`[codemap-boost-codex] ${prepared.diagnostic}\n`);
    return 1;
  }
  const launch = options.spawn || spawn;
  try {
    const session = await createSerenaSession(prepared, options);
    const command = (request) => sessionCommand(prepared, { ...request, home: session.home }, options);
    const proxy = new SerenaMcpProxy({ ...options,
      launchBackend: () => launch(prepared.command, prepared.args, {
        cwd: options.pluginDataDir, env: prepared.env, stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: process.platform === 'win32', detached: process.platform !== 'win32',
      }),
      resolveProject: options.resolveProject || ((project) => command({ command: 'resolve', project })),
      applySession: options.applySession || ((request) => command({ command: 'apply', ...request })),
      prepareProject: options.prepareProject || ((root) => require('./serena-project.cjs').prepareSerenaProject(root, options)),
    });
    const code = await proxy.run();
    if (code === 0) {
      try { cleanupSerenaSession(session, options); }
      catch (_) { stderr.write('[codemap-boost-codex] Serena 自有 session 清理未完成；稳定资源目录保持保留。\n'); }
    }
    return code;
  } catch (error) {
    stderr.write(`[codemap-boost-codex] Serena MCP 启动失败：${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  if (process.argv.slice(2).join(' ') === '--doctor') {
    const result = doctorSerena();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } else if (process.argv.length > 2) {
    process.stderr.write('[codemap-boost-codex] serena-server 只支持 --doctor；正常 MCP 启动不接收参数。\n');
    process.exitCode = 2;
  } else {
    runSerenaServer().then((code) => { process.exitCode = code; });
  }
}

module.exports = { prepareSerenaServer, runSerenaServer, sessionCommand, createSerenaSession, cleanupSerenaSession };
