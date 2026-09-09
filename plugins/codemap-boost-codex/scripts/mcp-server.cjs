'use strict';

const { spawn } = require('child_process');
const { crgRuntimePaths, ensureCrg } = require('../hooks/js/lib/bootstrap');
const { enableCodeMap, readBootstrapFailure } = require('../hooks/js/lib/codemap');
const { nodeRuntimeStatus } = require('../hooks/js/lib/runtime');
const { scheduleRuntimeUpdates } = require('../hooks/js/lib/runtime-updates');

/**
 * 确保插件私有 CRG 可用，并返回要启动的 MCP 命令。
 * @example prepareMcpServer().command
 */
function prepareMcpServer(options = {}) {
  const checkNode = options.nodeRuntimeStatus || nodeRuntimeStatus;
  const nodeStatus = checkNode();
  if (!nodeStatus.ok) {
    return {
      ok: false,
      diagnostic: `Node.js ${nodeStatus.version || '未知'} 不受支持；需要 ${nodeStatus.requirement}。`,
    };
  }
  const ensure = options.ensureCrg || ensureCrg;
  const runtimePaths = options.crgRuntimePaths || crgRuntimePaths;
  const enable = options.enableCodeMap || enableCodeMap;
  if (!ensure(options)) {
    const readFailure = options.readBootstrapFailure || readBootstrapFailure;
    return {
      ok: false,
      diagnostic: readFailure()
        || 'code-review-graph 插件私有运行环境安装失败；请运行 setup 或 --doctor 查看诊断。',
    };
  }
  enable();
  // 更新器只在已有健康运行时后后台运行，不能占用 stdio 或推迟当前 MCP 启动。
  if (!options.ensureCrg || options.scheduleRuntimeUpdates) {
    try { (options.scheduleRuntimeUpdates || scheduleRuntimeUpdates)(options); } catch (_) {}
  }
  return { ok: true, command: runtimePaths(options).command, args: ['serve'] };
}

/**
 * 启动 CRG MCP 服务并转发终止信号，标准输出仅用于 MCP 协议。
 * @example await runMcpServer()
 */
async function runMcpServer(options = {}) {
  const prepared = prepareMcpServer(options);
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
        stdio: 'inherit',
        windowsHide: process.platform === 'win32',
      });
      child.once('error', (error) => {
        stderr.write(`[codemap-boost-codex] MCP 启动失败：${error.message}\n`);
        finish(1);
      });
      child.once('exit', (code) => finish(code));
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, handlers[signal]);
    } catch (error) {
      stderr.write(`[codemap-boost-codex] MCP 启动失败：${error.message}\n`);
      finish(1);
    }
  });
}

if (require.main === module) {
  runMcpServer().then((code) => { process.exitCode = code; });
}

module.exports = { prepareMcpServer, runMcpServer };
