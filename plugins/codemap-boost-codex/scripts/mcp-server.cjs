'use strict';

const { spawn } = require('child_process');
const path = require('node:path');
const { crgRuntimePaths, ensureCrg } = require('../hooks/js/lib/bootstrap');
const { enableCodeMap, readBootstrapFailure } = require('../hooks/js/lib/codemap');
const { nodeRuntimeStatus } = require('../hooks/js/lib/runtime');
const { scheduleRuntimeUpdates } = require('../hooks/js/lib/runtime-updates');
const { enterMcpDataDir } = require('./mcp-cwd.cjs');
const { loadCatalog, recordSelectedCrgRuntime, selectCrgRuntime } = require('../hooks/js/lib/mcp-catalog');
const { LazyMcpProxy, killProcessTree } = require('./lazy-mcp.cjs');

/**
 * Ensure the private CRG runtime is available and return the MCP launch command.
 * @example prepareMcpServer().command
 */
function prepareMcpServer(options = {}) {
  const checkNode = options.nodeRuntimeStatus || nodeRuntimeStatus;
  const nodeStatus = checkNode();
  if (!nodeStatus.ok) {
    return {
      ok: false,
      diagnostic: `Node.js ${nodeStatus.version || 'unknown'} is unsupported; requires ${nodeStatus.requirement}.`,
    };
  }
  if (!options.ensureCrg) options = selectCrgRuntime(options);
  const ensure = options.ensureCrg || ensureCrg;
  const runtimePaths = options.crgRuntimePaths || crgRuntimePaths;
  const enable = options.enableCodeMap || enableCodeMap;
  if (!ensure(options)) {
    const readFailure = options.readBootstrapFailure || readBootstrapFailure;
    return {
      ok: false,
      diagnostic: readFailure()
        || 'Private code-review-graph runtime installation failed; run setup or --doctor for diagnostics.',
    };
  }
  recordSelectedCrgRuntime(options);
  enable();
  // Run background updates only after a healthy runtime exists, without taking stdio or delaying current MCP startup.
  if (!options.ensureCrg || options.scheduleRuntimeUpdates) {
    try { (options.scheduleRuntimeUpdates || scheduleRuntimeUpdates)({ ...options, kinds: ['crg'] }); } catch (_) {}
  }
  return { ok: true, command: runtimePaths(options).command, args: ['serve'] };
}

function prepareMcpServerAsync(options = {}, signal) {
  if (options.prepareBackend) return options.prepareBackend(options, signal);
  // Existing unit-test dependency injection does not serialize across processes; normal operation always uses a separate prepare process.
  if (options.ensureCrg) return Promise.resolve().then(() => prepareMcpServer(options));
  const selected = selectCrgRuntime(options);
  const serialized = {};
  for (const key of ['pluginDataDir', 'codexHome', 'pluginRoot', 'version', 'expectedVersion', 'runtimeDir']) {
    if (selected[key]) serialized[key] = selected[key];
  }
  return new Promise((resolve, reject) => {
    let child, stdout = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => {
      killProcessTree(child).then(() => finish(new Error('CRG preparation cancelled')), (error) => {
        (options.stderr || process.stderr).write(`[codemap-boost-codex] CRG preparation termination failed: ${error.message}\n`);
        // Failed shutdown does not prove prepare exited; retain launch waiting to avoid a second heavy prepare process.
        if (child.exitCode != null || child.signalCode != null) finish(new Error('CRG preparation cancelled'));
      });
    };
    if (signal && signal.aborted) return finish(new Error('CRG preparation cancelled'));
    try {
      child = (options.prepareSpawn || spawn)(process.execPath, [path.join(__dirname, 'mcp-prepare.cjs'), JSON.stringify(serialized)], {
        cwd: selected.pluginDataDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, ...(options.env || {}) },
      });
      if (signal) signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => (options.stderr || process.stderr).write(chunk));
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (signal && signal.aborted) return finish(new Error('CRG preparation cancelled'));
        try {
          const result = JSON.parse(stdout.trim());
          if (code !== 0 || !result.ok) throw new Error(result.diagnostic || `CRG preparation exited (${code})`);
          finish(null, result);
        } catch (error) { finish(error); }
      });
    } catch (error) { finish(error); }
  });
}

/** Reserve stdout for MCP; discovery does not ensure/probe/serve, and the first actual request prepares asynchronously. */
async function runMcpServer(options = {}) {
  const stderr = options.stderr || process.stderr;
  let resolved;
  try { resolved = selectCrgRuntime(enterMcpDataDir(options)); } catch (error) {
    stderr.write(`[codemap-boost-codex] MCP data directory unavailable: ${error.message}\n`); return 1;
  }
  const status = (options.nodeRuntimeStatus || nodeRuntimeStatus)();
  if (!status.ok) { stderr.write(`[codemap-boost-codex] Node.js ${status.version} is unsupported; requires ${status.requirement}.\n`); return 1; }
  const proxy = new LazyMcpProxy({
    ...resolved,
    catalog: options.catalog || ((signal) => loadCatalog({ ...resolved, signal })),
    launchBackend: options.launchBackend || (async (signal) => {
      const prepared = await prepareMcpServerAsync(resolved, signal);
      if (!prepared.ok) throw new Error(prepared.diagnostic);
      if (signal.aborted) throw new Error('CRG startup cancelled');
      return (options.spawn || spawn)(prepared.command, prepared.args, {
        cwd: resolved.pluginDataDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, ...(options.env || {}) },
      });
    }),
  });
  return proxy.run();
}

if (require.main === module) {
  runMcpServer().then((code) => { process.exitCode = code; });
}

module.exports = { prepareMcpServer, prepareMcpServerAsync, runMcpServer };
