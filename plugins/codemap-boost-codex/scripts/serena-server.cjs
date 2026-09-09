'use strict';

const { spawn } = require('child_process');
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
    try { (options.scheduleRuntimeUpdates || scheduleRuntimeUpdates)(options); } catch (_) {}
  }
  const paths = (options.serenaRuntimePaths || serenaRuntimePaths)(options);
  return {
    ok: true,
    command: paths.command,
    args: [...SERENA_MCP_ARGS],
    env: (options.serenaLaunchEnv || serenaLaunchEnv)(options),
  };
}

async function runSerenaServer(options = {}) {
  const prepared = prepareSerenaServer(options);
  const stderr = options.stderr || process.stderr;
  if (!prepared.ok) {
    stderr.write(`[codemap-boost-codex] ${prepared.diagnostic}\n`);
    return 1;
  }
  const launch = options.spawn || spawn;
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, handlers[signal]);
      resolve(Number.isInteger(code) ? code : 1);
    };
    const handlers = {
      SIGINT: () => { try { child.kill('SIGINT'); } catch (_) {} },
      SIGTERM: () => { try { child.kill('SIGTERM'); } catch (_) {} },
    };
    try {
      child = launch(prepared.command, prepared.args, {
        cwd: options.cwd || process.cwd(),
        env: prepared.env,
        stdio: 'inherit',
        windowsHide: process.platform === 'win32',
      });
      child.once('error', (error) => { stderr.write(`[codemap-boost-codex] Serena MCP 启动失败：${error.message}\n`); finish(1); });
      child.once('exit', (code) => finish(code));
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, handlers[signal]);
    } catch (error) {
      stderr.write(`[codemap-boost-codex] Serena MCP 启动失败：${error.message}\n`);
      finish(1);
    }
  });
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

module.exports = { prepareSerenaServer, runSerenaServer };
