'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DISABLED_FEATURES = [
  'hooks', 'plugins', 'apps', 'shell_tool', 'memories', 'multi_agent',
  'browser_use', 'computer_use', 'image_generation', 'view_image',
  'code_mode_host', 'unified_exec',
];

/** Return configuration scoped to the naming subprocess without changing user configuration or authentication. */
function isolatedConfig() {
  return {
    ...Object.fromEntries(DISABLED_FEATURES.map((feature) => [`features.${feature}`, false])),
    project_doc_max_bytes: 0,
    service_tier: 'default',
    web_search: 'disabled',
  };
}

function executableFile(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Select an executable for the recognized host; prefer the standalone CLI on PATH when the host is unknown. */
function resolveCodexCommand({ env = process.env, platform = process.platform, systemApplicationsRoot = '/Applications' } = {}) {
  const windows = platform === 'win32';
  const names = windows ? ['codex.exe'] : ['codex'];
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  const originator = String(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || '').trim().toLowerCase();
  const desktopHost = originator === 'codex desktop' || (!originator && Boolean(env.CODEX_APP_TOOLS_PIPE_PATH));
  const cliHost = originator === 'codex_cli_rs' || originator === 'codex_cli';
  const cliOnPath = [];
  const desktopOnPath = [];
  for (const entry of pathValue.split(windows ? ';' : ':')) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    for (const name of names) {
      const file = path.join(directory, name);
      if (!executableFile(file, platform)) continue;
      const normalized = file.replace(/\\/g, '/');
      if ((windows && /\/OpenAI\/Codex\/bin\/[^/]+\/codex\.exe$/i.test(normalized)) ||
          (platform === 'darwin' && /(?:^|\/)Codex\.app\/Contents\/Resources\/(?:[^/]+\/)*codex$/i.test(normalized))) desktopOnPath.push(file);
      else cliOnPath.push(file);
    }
  }
  if (desktopHost && (windows || platform === 'darwin')) {
    const hinted = env.CODEX_CLI_PATH;
    const absoluteHint = typeof hinted === 'string' &&
      (windows ? path.win32.isAbsolute(hinted) : path.posix.isAbsolute(hinted));
    if (absoluteHint && executableFile(hinted, platform)) return hinted;
    return desktopOnPath[0] || findInstalledDesktopCommand(env, platform, systemApplicationsRoot);
  }
  if (cliHost) return cliOnPath[0] || null;
  if (cliOnPath.length) return cliOnPath[0];
  if (desktopOnPath.length) return desktopOnPath[0];
  return findInstalledDesktopCommand(env, platform, systemApplicationsRoot);
}

function findInstalledDesktopCommand(env, platform, systemApplicationsRoot) {
  const windows = platform === 'win32';
  if (platform === 'darwin') {
    const locations = [
      path.join(systemApplicationsRoot, 'Codex.app', 'Contents', 'Resources', 'codex'),
      ...(env.HOME ? [path.join(env.HOME, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex')] : []),
    ];
    return locations.find((file) => executableFile(file, platform)) || null;
  }
  if (!windows || !env.LOCALAPPDATA) return null;

  // Check only direct children of the desktop installation directory; do not depend on a version hash or recursively scan user directories.
  const bin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  let versions;
  try {
    versions = fs.readdirSync(bin, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const version of versions) {
    if (!version.isDirectory()) continue;
    const file = path.join(bin, version.name, 'codex.exe');
    if (!executableFile(file, platform)) continue;
    try {
      candidates.push({ file, mtime: fs.statSync(file).mtimeMs });
    } catch {
      // The installation may update during the scan; skip candidates that have disappeared.
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  return candidates[0]?.file || null;
}

/**
 * Start a stdio JSON-RPC client bounded by an overall timeout.
 * Reject all server requests; expose only local error codes to avoid forwarding sensitive server text.
 * Callers must await close() to reap the subprocess; spawnImpl exists only to substitute a process in tests.
 */
function createAppServer({ cwd, timeoutMs = 60000, command, spawnImpl = spawn, env = process.env, platform = process.platform } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_timeout');
  const executable = command === undefined ? resolveCodexCommand({ env, platform }) : command;
  if (executable === null) throw new Error('app_server_unavailable');
  const args = ['app-server'];
  for (const [key, value] of Object.entries(isolatedConfig())) {
    args.push('-c', `${key}=${JSON.stringify(value)}`);
  }
  const child = spawnImpl(executable, args, {
    cwd,
    env: { ...env, CONVERSATION_NAMER_WORKER: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  const notifications = new Set();
  const failures = new Set();
  let sequence = 0;
  let buffer = '';
  let failure = null;
  let exited = false;
  let closing = null;
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });

  function abort(code) {
    if (failure) return;
    failure = new Error(code);
    clearTimeout(deadline);
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
    for (const listener of failures) listener(failure);
    child.kill();
  }

  const deadline = setTimeout(() => abort('app_server_timeout'), timeoutMs);
  child.once('error', () => {
    abort('app_server_unavailable');
    if (!child.pid) {
      exited = true;
      resolveExit();
    }
  });
  child.once('exit', () => {
    exited = true;
    resolveExit();
    abort('app_server_exited');
  });
  child.stdin.on('error', () => abort('app_server_write_failed'));
  child.stdout.setEncoding('utf8');
  // Consume stderr without logging diagnostics that may contain provider details.
  child.stderr.resume();

  function send(message) {
    if (failure) throw failure;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  child.stdout.on('data', (chunk) => {
    if (failure) return;
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) return abort('app_server_output_too_large');
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return abort('app_server_invalid_json');
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return abort('app_server_invalid_message');
      }
      if (typeof message.method === 'string') {
        if (Object.hasOwn(message, 'id')) {
          send({ id: message.id, error: { code: -32601, message: 'Naming does not allow server requests.' } });
          return abort('app_server_request_rejected');
        }
        for (const listener of notifications) listener(message.method, message.params || {});
      } else if (pending.has(message.id)) {
        const { resolve, reject, method } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          // Preserve only the operation and numeric code, never provider text or request content.
          const error = new Error('app_server_rpc_failed');
          error.rpcMethod = method;
          if (Number.isInteger(message.error.code)) error.rpcCode = message.error.code;
          reject(error);
        }
        else if (Object.hasOwn(message, 'result')) resolve(message.result);
        else reject(new Error('app_server_invalid_response'));
      }
      if (failure) return;
    }
  });

  return {
    request(method, params = {}) {
      if (failure) return Promise.reject(failure);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        try {
          send({ id, method, params });
        } catch {
          abort('app_server_write_failed');
        }
      });
    },
    notify(method, params) { send({ method, ...(params === undefined ? {} : { params }) }); },
    onNotification(listener) {
      notifications.add(listener);
      return () => notifications.delete(listener);
    },
    onFailure(listener) {
      if (failure) listener(failure);
      else failures.add(listener);
      return () => failures.delete(listener);
    },
    abort,
    close() {
      if (closing) return closing;
      closing = (async () => {
        abort('app_server_closed');
        child.stdin.end();
        if (!exited) {
          const force = setTimeout(() => child.kill('SIGKILL'), 250);
          const stopWaiting = setTimeout(resolveExit, 1000);
          await exit;
          clearTimeout(force);
          clearTimeout(stopWaiting);
        }
        child.stdout.destroy();
        child.stderr.destroy();
        notifications.clear();
        failures.clear();
      })();
      return closing;
    },
  };
}

module.exports = { createAppServer, isolatedConfig, resolveCodexCommand };
