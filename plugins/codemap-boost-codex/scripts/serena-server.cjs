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
const { OWNER_ENV, createOwner, cleanupOwned } = require('./serena-processes.cjs');

/** Prefer normal EOF; on POSIX verify independent sessions even after root exit. Preserve Windows live-child tree protection. */
async function stopSerenaBackend(context, prepared, options = {}) {
  try { context.child.stdin.end(); } catch (_) {}
  if ((options.platform || process.platform) === 'win32') {
    if (!context.exited) await (options.killTree || killProcessTree)(context.child);
    return;
  }
  if (!context.exited) {
    let timer;
    try {
      await Promise.race([context.exit, new Promise((resolve) => {
        timer = setTimeout(resolve, options.gracefulStopMs ?? 3000);
      })]);
    } finally { clearTimeout(timer); }
  }
  await (options.cleanupOwned || cleanupOwned)(prepared.python, context.child.serenaOwner,
    { timeoutMs: options.stopTimeoutMs || 10000 });
}

function prepareSerenaServer(options = {}) {
  const node = (options.nodeRuntimeStatus || nodeRuntimeStatus)();
  if (!node.ok) return { ok: false, diagnostic: `Node.js ${node.version || 'unknown'} is unsupported; requires ${node.requirement}.` };
  const ensure = options.ensureSerena || ensureSerena;
  if (!ensure(options)) {
    return {
      ok: false,
      diagnostic: (options.readFailureMarker || readFailureMarker)(serenaFailureMarker(options))
        || 'Private Serena runtime installation failed; run --doctor for diagnostics.',
    };
  }
  // Isolate background updates from the current stdio service; never overwrite active Serena venvs in place.
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
    // Helper exceptions may contain configuration values; do not forward stderr, and return only safe protocol summaries.
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
  // macOS /tmp and user data aliases may traverse links; use the real parent directory as the cleanup boundary.
  const sessions = fs.realpathSync(sessionsPath);
  const home = path.join(sessions, crypto.randomUUID());
  prepared.env = { ...prepared.env, SERENA_HOME: home };
  const result = await sessionCommand(prepared, { command: 'clone', home, source }, options);
  if (!result.ok) throw new Error('Serena private session configuration clone failed');
  // LSP executables belong to the stable plugin home; UUID sessions must not cause repeated downloads.
  const resources = path.join(source, 'language_servers');
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.symlinkSync(fs.realpathSync(resources), path.join(home, 'language_servers'), process.platform === 'win32' ? 'junction' : 'dir');
  return { home, source, sessions };
}

function cleanupSerenaSession(session, options) {
  const sessions = fs.realpathSync(path.join(options.pluginDataDir, 'serena-sessions'));
  const home = path.resolve(session.home);
  // Delete only this UUID directory. Unlink owned resource links first; never recurse into the stable LSP directory.
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
    stderr.write(`[codemap-boost-codex] Serena MCP data directory unavailable: ${error.message}\n`);
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
      launchBackend: () => {
        const owner = createOwner();
        const child = launch(prepared.command, prepared.args, {
          cwd: options.pluginDataDir, env: { ...prepared.env, [OWNER_ENV]: owner }, stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: process.platform === 'win32', detached: process.platform !== 'win32',
        });
        child.serenaOwner = owner;
        return child;
      },
      stopBackend: (context) => stopSerenaBackend(context, prepared, options),
      resolveProject: options.resolveProject || ((project) => command({ command: 'resolve', project })),
      applySession: options.applySession || ((request) => command({ command: 'apply', ...request })),
      prepareProject: options.prepareProject || ((root) => require('./serena-project.cjs').prepareSerenaProject(root, options)),
    });
    const code = await proxy.run();
    if (code === 0) {
      try { cleanupSerenaSession(session, options); }
      catch (_) {
        stderr.write('[codemap-boost-codex] Serena owned session cleanup incomplete; stable resources have been preserved.\n');
        return 1;
      }
    }
    return code;
  } catch (error) {
    stderr.write(`[codemap-boost-codex] Serena MCP launch failed: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  if (process.argv.slice(2).join(' ') === '--doctor') {
    const result = doctorSerena();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } else if (process.argv.length > 2) {
    process.stderr.write('[codemap-boost-codex] serena-server only supports --doctor; normal MCP startup accepts no arguments.\n');
    process.exitCode = 2;
  } else {
    runSerenaServer().then((code) => { process.exitCode = code; });
  }
}

module.exports = { prepareSerenaServer, runSerenaServer, sessionCommand, createSerenaSession, cleanupSerenaSession, stopSerenaBackend };
