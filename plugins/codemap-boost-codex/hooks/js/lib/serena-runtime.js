'use strict';

const fs = require('fs');
const path = require('path');
const {
  MCP_BOOTSTRAP_BUDGET_MS,
  acquireInstallLock,
  installManagedCrg,
  releaseInstallLock,
} = require('./bootstrap');
const { pluginDataDir } = require('./runtime');
const { activeRuntimeVersion, isRuntimeVersion } = require('./runtime-versions');

const SERENA_VERSION = '1.7.0';
const SERENA_PACKAGE = `serena-agent==${SERENA_VERSION}`;
const SERENA_RUNTIME_DIR = 'serena-runtime';
const SERENA_HOME_DIR = 'serena-home';
const SERENA_MCP_ARGS = [
  'start-mcp-server',
  '--context', 'codex',
  '--enable-web-dashboard', 'false',
  '--open-web-dashboard', 'false',
  '--enable-gui-log-window', 'false',
];

function serenaPluginDataDir(options = {}) {
  return path.resolve(options.pluginDataDir || pluginDataDir(options));
}

/** Return the version-isolated Serena venv path; never share the CRG runtime. */
function serenaRuntimePaths(options = {}) {
  const windows = (options.platform || process.platform) === 'win32';
  const pathApi = windows ? path.win32 : path.posix;
  const data = pathApi.resolve(options.pluginDataDir || serenaPluginDataDir(options));
  const requested = options.version || process.env.CODEMAP_BOOST_SERENA_RUNTIME_VERSION;
  const version = isRuntimeVersion(requested)
    ? requested
    : activeRuntimeVersion('serena', { pluginDataDir: data }) || SERENA_VERSION;
  const dir = pathApi.resolve(options.runtimeDir || pathApi.join(data, SERENA_RUNTIME_DIR, version));
  const binDir = pathApi.join(dir, windows ? 'Scripts' : 'bin');
  return {
    data,
    dir,
    python: pathApi.join(binDir, windows ? 'python.exe' : 'python'),
    command: pathApi.join(binDir, windows ? 'serena.exe' : 'serena'),
    version,
  };
}

function serenaHomeDir(options = {}) {
  const windows = (options.platform || process.platform) === 'win32';
  const pathApi = windows ? path.win32 : path.posix;
  const data = options.pluginDataDir || serenaPluginDataDir(options);
  return pathApi.resolve(options.serenaHomeDir || pathApi.join(data, SERENA_HOME_DIR));
}

function runtimeOptions(options = {}) {
  const paths = serenaRuntimePaths(options);
  // Freeze the version and absolute venv directory; do not reread the active pointer while waiting on the installation lock.
  return { ...options, runtimeDir: paths.dir, version: paths.version, pluginDataDir: paths.data };
}

function recordDiagnostic(options, message) {
  if (Array.isArray(options.diagnostics)) options.diagnostics.push(String(message));
}

function errorSummary(error) {
  return String((error && (error.code || error.message)) || error || 'unknown error');
}

/** Verify Python version, pinned package version, and CLI importability without writing Serena configuration. */
function probeSerenaRuntime(options = {}) {
  const paths = serenaRuntimePaths(options);
  const exists = options.pathExists || fs.existsSync;
  const spawn = options.spawnSync || require('child_process').spawnSync;
  if (!exists(paths.python)) {
    recordDiagnostic(options, `Managed Serena Python is missing: ${paths.python}`);
    return false;
  }
  if (!exists(paths.command)) {
    recordDiagnostic(options, `Managed Serena CLI is missing: ${paths.command}`);
    return false;
  }
  const script = [
    'import sys',
    'from importlib.metadata import version',
    'assert (3, 11) <= sys.version_info[:2] < (3, 15), sys.version',
    `assert version('serena-agent') == '${paths.version}', version('serena-agent')`,
    'from serena.cli import top_level',
    'assert top_level is not None',
  ].join('; ');
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const requestedTimeout = options.probeTimeout || 15000;
  const timeout = Number.isFinite(options.deadlineMs)
    ? Math.max(0, Math.min(requestedTimeout, options.deadlineMs - now))
    : requestedTimeout;
  if (timeout <= 0) {
    recordDiagnostic(options, 'Managed Serena health probe skipped: startup budget exhausted');
    return false;
  }
  try {
    const result = spawn(paths.python, ['-I', '-B', '-c', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: process.platform === 'win32',
      env: serenaLaunchEnv(options),
    });
    if (!result || result.error || result.status !== 0) {
      recordDiagnostic(options, `Managed Serena health probe failed: ${result && result.error ? errorSummary(result.error) : `exit code ${result && result.status}`}`);
      return false;
    }
    return true;
  } catch (error) {
    recordDiagnostic(options, `Managed Serena health probe error: ${errorSummary(error)}`);
    return false;
  }
}

function writeFailureMarker(file, message) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${message}\n`, 'utf8');
  } catch (_) {}
}

function readFailureMarker(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) { return ''; }
}

function serenaFailureMarker(options = {}) {
  return options.markerPath || path.join(serenaPluginDataDir(options), '.serena-install-failed');
}

function clearFailureMarker(file) {
  try { fs.rmSync(file, { force: true }); } catch (_) {}
}

/** Install a separate Serena venv using CRG-proven venv creation, installation locking, and the absolute startup budget. */
function ensureSerena(options = {}) {
  const diagnostics = Array.isArray(options.diagnostics) ? options.diagnostics : [];
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const ownDeadline = now + MCP_BOOTSTRAP_BUDGET_MS;
  const deadlineMs = Number.isFinite(options.deadlineMs) ? Math.min(options.deadlineMs, ownDeadline) : ownDeadline;
  const selected = runtimeOptions({ ...options, diagnostics, deadlineMs });
  const scoped = { ...selected, expectedVersion: selected.version };
  const marker = serenaFailureMarker(scoped);
  const probe = scoped.probeRuntime || probeSerenaRuntime;
  const install = scoped.installRuntime || installManagedCrg;
  let healthy = false;
  try { healthy = !!probe(scoped); } catch (error) { recordDiagnostic(scoped, errorSummary(error)); }
  if (healthy) {
    clearFailureMarker(marker);
    return true;
  }

  const lockFile = scoped.installLockPath || `${serenaRuntimePaths(scoped).dir}.install.lock`;
  const acquire = scoped.acquireInstallLock || acquireInstallLock;
  const release = scoped.releaseInstallLock || releaseInstallLock;
  let token = null;
  try { token = acquire(lockFile, scoped); } catch (error) { recordDiagnostic(scoped, `Failed to acquire Serena installation lock: ${errorSummary(error)}`); }
  if (!token) {
    const detail = diagnostics.join('; ');
    writeFailureMarker(marker, `Serena private runtime could not wait for the installation lock. ${detail}`);
    return false;
  }
  try {
    try { healthy = !!probe(scoped); } catch (error) { recordDiagnostic(scoped, errorSummary(error)); }
    if (!healthy) {
      let installed = false;
      const expected = serenaRuntimePaths(scoped).version;
      try { installed = !!install(`serena-agent==${expected}`, { ...scoped, expectedVersion: expected, probeRuntime: probe }); } catch (error) {
        recordDiagnostic(scoped, `Serena private runtime installation error: ${errorSummary(error)}`);
      }
      try { healthy = installed && !!probe(scoped); } catch (error) { recordDiagnostic(scoped, errorSummary(error)); }
    }
    if (healthy) {
      clearFailureMarker(marker);
      return true;
    }
  } finally {
    try { release(lockFile, token); } catch (_) {}
  }
  const detail = [...new Set(diagnostics)].slice(-6).join('; ');
  writeFailureMarker(marker, `Serena ${SERENA_PACKAGE} private runtime installation or health check failed. ${detail}`);
  return false;
}

function serenaLaunchEnv(options = {}) {
  return {
    ...process.env,
    ...(options.env || {}),
    SERENA_HOME: serenaHomeDir(options),
  };
}

/** Read-only check: never create a venv, install packages, write markers, or modify user Serena/CC configuration. */
function doctorSerena(options = {}) {
  const diagnostics = [];
  const scoped = runtimeOptions({ ...options, diagnostics });
  const ok = probeSerenaRuntime(scoped);
  return {
    ok,
    package: `serena-agent==${serenaRuntimePaths(scoped).version}`,
    runtimeDir: serenaRuntimePaths(scoped).dir,
    serenaHome: serenaHomeDir(scoped),
    diagnostic: diagnostics.join('; '),
  };
}

module.exports = {
  SERENA_VERSION,
  SERENA_PACKAGE,
  SERENA_MCP_ARGS,
  serenaPluginDataDir,
  serenaRuntimePaths,
  serenaHomeDir,
  probeSerenaRuntime,
  ensureSerena,
  serenaLaunchEnv,
  doctorSerena,
  readFailureMarker,
  serenaFailureMarker,
};
