'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isWindows, markerPath, pluginDataDir, writeMarker } = require('./runtime');
const { commandExists } = require('./runtime');
const { activeRuntimeVersion } = require('./runtime-versions');

const CRG_PACKAGE = 'code-review-graph[all]';
const CRG_RUNTIME_DIR = 'crg-runtime';
const CRG_VERSIONED_RUNTIME_DIR = 'crg-runtimes';
const CRG_PYTHON_VERSION = '3.12';
const MCP_STARTUP_TIMEOUT_SEC = 10 * 60;
const MCP_BOOTSTRAP_RESERVE_MS = 30 * 1000;
const MCP_BOOTSTRAP_BUDGET_MS = MCP_STARTUP_TIMEOUT_SEC * 1000 - MCP_BOOTSTRAP_RESERVE_MS;
const INSTALL_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_LOCK_WAIT_MS = 9 * 60 * 1000;
const INSTALL_LOCK_BOOT_MS = 5000;

/**
 * Return Python launcher candidates for the current platform; an explicit platform parameter is only for cross-platform tests.
 * @example pythonCandidates({ platform: 'win32' })
 */
function pythonCandidates(options = {}) {
  const windows = (options.platform || process.platform) === 'win32';
  const candidates = [];
  if (process.env.CODEMAP_BOOST_PYTHON) {
    const args = (process.env.CODEMAP_BOOST_PYTHON_ARGS || '').trim().split(/\s+/).filter(Boolean);
    candidates.push([process.env.CODEMAP_BOOST_PYTHON, args]);
  }
  if (windows) {
    candidates.push(['py', ['-3.12']]);
    candidates.push(['py', ['-3.11']]);
  }
  candidates.push(['python3.12', []]);
  candidates.push(['python3.11', []]);
  candidates.push(['python', []]);
  candidates.push(['python3', []]);
  if (windows) candidates.push(['py', ['-3']]);
  return candidates;
}

function pipInstall(pkg) {
  for (const [py, baseArgs] of pythonCandidates()) {
    try {
      const result = spawnSync(
        py,
        [...baseArgs, '-m', 'pip', 'install', '--disable-pip-version-check', pkg],
        { stdio: 'ignore', timeout: INSTALL_COMMAND_TIMEOUT_MS, windowsHide: isWindows }
      );
      if (!result.error && result.status === 0) return true;
    } catch (_) {}
  }
  return false;
}

/**
 * Return the absolute path to the plugin-private CRG runtime.
 * @example crgRuntimePaths().command
 */
function crgRuntimePaths(options = {}) {
  const platform = options.platform || process.platform;
  const windows = platform === 'win32';
  const pathApi = windows ? path.win32 : path.posix;
  // `runtimeDir` is for doctor/candidate validation and must take precedence over the active-version pointer.
  const data = options.pluginDataDir || pluginDataDir(options);
  const version = options.version || activeRuntimeVersion('crg', { pluginDataDir: data });
  const dir = pathApi.resolve(options.runtimeDir || (version
    ? pathApi.join(data, CRG_VERSIONED_RUNTIME_DIR, version)
    : pathApi.join(data, CRG_RUNTIME_DIR)));
  const binDir = pathApi.join(dir, windows ? 'Scripts' : 'bin');
  return {
    dir,
    python: pathApi.join(binDir, windows ? 'python.exe' : 'python'),
    command: pathApi.join(binDir, windows ? 'code-review-graph.exe' : 'code-review-graph'),
  };
}

function recordDiagnostic(options, message) {
  if (Array.isArray(options.diagnostics)) options.diagnostics.push(String(message));
}

function errorSummary(error) {
  if (!error) return 'unknown error';
  return String(error.code || error.message || error);
}

/**
 * Compute this step’s timeout within the shared absolute deadline.
 * @example boundedTimeout({ deadlineMs: Date.now() + 1000 }, 5000)
 */
function boundedTimeout(options, requestedMs) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const configured = options.timeout ?? requestedMs;
  if (!Number.isFinite(options.deadlineMs)) return configured;
  return Math.max(0, Math.min(configured, options.deadlineMs - now));
}

function runOk(command, args, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const label = options.diagnosticLabel || command;
  const timeout = boundedTimeout(options, INSTALL_COMMAND_TIMEOUT_MS);
  if (timeout <= 0) {
    recordDiagnostic(options, `${label} skipped: startup budget exhausted`);
    return false;
  }
  try {
    const result = spawn(command, args, {
      encoding: 'utf8',
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: isWindows,
    });
    if (result && !result.error && result.status === 0) return true;
    const reason = result && result.error
      ? errorSummary(result.error)
      : `exit code ${result && result.status !== undefined ? result.status : 'unknown'}`;
    recordDiagnostic(options, `${label} failed: ${reason}`);
    return false;
  } catch (error) {
    recordDiagnostic(options, `${label} error: ${errorSummary(error)}`);
    return false;
  }
}

/**
 * Verify the CLI and four parsers using upstream `python -I -B` mode without writing pycache.
 * @example probeCrgRuntime({ runtimeDir: 'C:\\plugin-data\\crg-runtime' })
 */
function probeCrgRuntime(options = {}) {
  const paths = crgRuntimePaths(options);
  const exists = options.pathExists || fs.existsSync;
  const probeOptions = { ...options, timeout: options.probeTimeout || 15000 };
  try {
    if (!exists(paths.python)) {
      recordDiagnostic(options, `Managed Python is missing: ${paths.python}`);
      return false;
    }
    if (!exists(paths.command)) {
      recordDiagnostic(options, `Managed CRG is missing: ${paths.command}`);
      return false;
    }
    if (!runOk(paths.command, ['--version'], {
      ...probeOptions,
      diagnosticLabel: 'managed CRG version probe',
    })) return false;
    const parserProbe = [
      ...(options.expectedVersion ? [
        'from importlib.metadata import version',
        `assert version('code-review-graph') == ${JSON.stringify(String(options.expectedVersion))}, version('code-review-graph')`,
      ] : []),
      'from tree_sitter_language_pack import get_parser',
      "for grammar in ('python', 'javascript', 'typescript', 'tsx'):",
      '    get_parser(grammar)',
    ].join('\n');
    return runOk(paths.python, ['-I', '-B', '-c', parserProbe], {
      ...probeOptions,
      diagnosticLabel: 'managed parser -I -B probe',
    });
  } catch (error) {
    recordDiagnostic(options, `Managed runtime health-check error: ${errorSummary(error)}`);
    return false;
  }
}

function removeManagedRuntime(runtimeDir) {
  try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Rebuild the isolated venv in plugin data and install CRG only there.
 * @example installManagedCrg('code-review-graph[all]')
 */
function installManagedCrg(pkg = CRG_PACKAGE, options = {}) {
  const paths = crgRuntimePaths(options);
  const exists = options.pathExists || fs.existsSync;
  const uvProbe = options.uvProbe || commandExists;
  const candidates = options.pythonCandidates || pythonCandidates;
  const probe = options.probeRuntime || probeCrgRuntime;
  const pythonVersion = process.env.CODEMAP_BOOST_PYTHON_VERSION || CRG_PYTHON_VERSION;

  // Install only after a failed health check; remove the damaged private runtime before rebuilding.
  removeManagedRuntime(paths.dir);

  let uvAvailable = false;
  try {
    uvAvailable = !!uvProbe('uv');
  } catch (error) {
    recordDiagnostic(options, `uv detection error: ${errorSummary(error)}`);
  }
  if (uvAvailable) {
    const created = runOk('uv', ['venv', '--python', pythonVersion, paths.dir], {
      ...options,
      diagnosticLabel: 'uv venv',
    });
    if (created && exists(paths.python)) {
      const installed = runOk('uv', [
        'pip', 'install', '--python', paths.python, '--upgrade', pkg,
      ], { ...options, diagnosticLabel: 'uv pip install' });
      let healthy = false;
      try { healthy = installed && !!probe(options); } catch (error) {
        recordDiagnostic(options, `uv post-install health-check error: ${errorSummary(error)}`);
      }
      if (healthy) return true;
    } else if (created) {
      recordDiagnostic(options, `uv venv did not create managed Python: ${paths.python}`);
    }
    removeManagedRuntime(paths.dir);
  }

  let pythonList = [];
  try { pythonList = candidates(options); } catch (error) {
    recordDiagnostic(options, `Python candidate detection error: ${errorSummary(error)}`);
  }
  for (const [python, baseArgs] of pythonList) {
    const created = runOk(python, [...baseArgs, '-m', 'venv', paths.dir], {
      ...options,
      diagnosticLabel: `${python} venv`,
    });
    if (!created || !exists(paths.python)) {
      if (created) recordDiagnostic(options, `${python} venv did not create managed Python: ${paths.python}`);
      removeManagedRuntime(paths.dir);
      continue;
    }
    const installed = runOk(paths.python, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', pkg,
    ], { ...options, diagnosticLabel: `${python} venv pip install` });
    let healthy = false;
    try { healthy = installed && !!probe(options); } catch (error) {
      recordDiagnostic(options, `${python} post-install health-check error: ${errorSummary(error)}`);
    }
    if (healthy) return true;
    removeManagedRuntime(paths.dir);
  }
  return false;
}

function writeFailureMarker(file, diagnostic) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${diagnostic}\n`, 'utf8');
  } catch (_) {}
}

/**
 * Wait synchronously in short polling intervals without spawning an extra shell.
 * @example sleepSync(100)
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Check whether the local process recorded in the lock file is still alive.
 * @example isPidAlive(process.pid)
 */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && error.code === 'EPERM';
  }
}

/**
 * Acquire the private-runtime installation lock to prevent concurrent rebuilds of one venv.
 * @example acquireInstallLock('/tmp/crg-runtime.install.lock')
 */
function acquireInstallLock(file, options = {}) {
  const waitMs = options.installLockWaitMs ?? INSTALL_LOCK_WAIT_MS;
  const bootMs = options.installLockBootMs ?? INSTALL_LOCK_BOOT_MS;
  const now = Date.now();
  const deadline = Math.min(
    now + waitMs,
    Number.isFinite(options.deadlineMs) ? options.deadlineMs : Number.POSITIVE_INFINITY
  );
  if (deadline <= now) return false;
  const token = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  while (Date.now() <= deadline) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') return false;
    }
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      let pid = Number.parseInt(raw, 10) || 0;
      try { pid = Number(JSON.parse(raw).pid) || 0; } catch (_) {}
      const age = Date.now() - fs.statSync(file).mtimeMs;
      // Do not steal an installation lock from a live process merely because it is slow; two tasks could rebuild the same venv.
      if (!isPidAlive(pid) && age > bootMs) {
        fs.rmSync(file, { force: true });
        continue;
      }
    } catch (_) {}
    sleepSync(100);
  }
  return false;
}

/**
 * Release the private-runtime installation lock held by this task.
 * @example releaseInstallLock('/tmp/crg-runtime.install.lock', token)
 */
function releaseInstallLock(file, token) {
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (current.token === token) fs.rmSync(file, { force: true });
  } catch (_) {}
}

function ensureCli(command, pkg, marker, opts = {}) {
  const probe = opts.probe || commandExists;
  const install = opts.install || pipInstall;
  const markerFile = opts.markerPath || markerPath(marker);
  const clearMarker = () => {
    try { fs.rmSync(markerFile, { force: true }); } catch (_) {}
  };
  if (probe(command)) {
    clearMarker();
    return true;
  }
  const installers = Array.isArray(opts.installers) && opts.installers.length > 0
    ? opts.installers
    : [{ name: 'pip', install }];
  const attempted = [];
  const lastFailure = 'Installer failed or the command is still missing after installation';
  for (const installer of installers) {
    const name = String(installer.name || 'installer');
    attempted.push(name);
    let installed = false;
    try { installed = !!installer.install(pkg); } catch (_) {}
    if (installed && probe(command)) {
      clearMarker();
      return true;
    }
  }
  const diagnostic = `${command} unavailable; tried ${attempted.join(', ')}; last result: ${lastFailure}; install ${pkg} and rerun setup.`;
  if (opts.markerPath) writeFailureMarker(markerFile, diagnostic);
  else {
    writeMarker(marker);
    try {
      fs.mkdirSync(path.dirname(markerFile), { recursive: true });
      fs.writeFileSync(markerFile, `${diagnostic}\n`, 'utf8');
    } catch (_) {}
  }
  return false;
}

/**
 * Ensure the plugin-private runtime is healthy; write an actionable diagnostic marker on failure.
 * @example ensureCrg()
 */
function ensureCrg(options = {}) {
  const probe = options.probeRuntime || probeCrgRuntime;
  const install = options.installRuntime || installManagedCrg;
  const diagnostics = Array.isArray(options.diagnostics) ? options.diagnostics : [];
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const ownDeadline = now + MCP_BOOTSTRAP_BUDGET_MS;
  const deadlineMs = Number.isFinite(options.deadlineMs)
    ? Math.min(options.deadlineMs, ownDeadline)
    : ownDeadline;
  // A promoted version can only be repaired to the exact package; upgrades require candidate validation and atomic pointer promotion.
  const activeVersion = options.expectedVersion || options.version || (!options.runtimeDir && activeRuntimeVersion('crg', {
    pluginDataDir: options.pluginDataDir || pluginDataDir(options),
  }));
  const expectedVersion = activeVersion || '';
    // From here, do not reread the active pointer: probe, lock, and install share one version and absolute-directory snapshot.
  const frozenRuntimeDir = path.resolve(options.runtimeDir || crgRuntimePaths({
    ...options, ...(expectedVersion ? { version: expectedVersion } : {}),
  }).dir);
  const markerFile = options.markerPath || markerPath('.crg-install-failed');
  const installPackage = expectedVersion ? `${CRG_PACKAGE}==${expectedVersion}` : CRG_PACKAGE;
  const runtimeOptions = {
    ...options, runtimeDir: frozenRuntimeDir, deadlineMs, diagnostics,
    ...(expectedVersion ? { version: expectedVersion, expectedVersion } : {}),
  };
  const clearMarker = () => {
    try { fs.rmSync(markerFile, { force: true }); } catch (_) {}
  };
  let healthy = false;
  try { healthy = !!probe(runtimeOptions); } catch (error) {
    recordDiagnostic(runtimeOptions, `Initial health-check error: ${errorSummary(error)}`);
  }
  if (healthy) {
    clearMarker();
    return true;
  }
  const lockFile = options.installLockPath || `${frozenRuntimeDir}.install.lock`;
  const acquire = options.acquireInstallLock || acquireInstallLock;
  const release = options.releaseInstallLock || releaseInstallLock;
  let lockToken = null;
  try {
    lockToken = acquire(lockFile, runtimeOptions);
    if (!lockToken) recordDiagnostic(runtimeOptions, `Timed out waiting for private-runtime installation lock: ${lockFile}`);
  } catch (error) {
    recordDiagnostic(runtimeOptions, `Failed to acquire private-runtime installation lock: ${errorSummary(error)}`);
  }
  if (lockToken) {
    try {
      // Another task may have installed while we waited for the lock; recheck before deciding to rebuild.
      try { healthy = !!probe(runtimeOptions); } catch (error) {
        recordDiagnostic(runtimeOptions, `Health-check error after locking: ${errorSummary(error)}`);
      }
      let installed = false;
      if (!healthy) {
        try { installed = !!install(installPackage, runtimeOptions); } catch (error) {
          recordDiagnostic(runtimeOptions, `Isolated-runtime installation error: ${errorSummary(error)}`);
        }
        try { healthy = installed && !!probe(runtimeOptions); } catch (error) {
          recordDiagnostic(runtimeOptions, `Post-install health-check error: ${errorSummary(error)}`);
        }
      }
      if (healthy) {
        clearMarker();
        return true;
      }
    } finally {
      release(lockFile, lockToken);
    }
  }
  const detail = [...new Set(diagnostics)].slice(-6).join('; ');
  const diagnostic = 'The isolated code-review-graph runtime installation or parser health check failed. '
    + (detail ? `Diagnostic: ${detail}. ` : '')
    + 'Do not repair with pip --user/user-site; rerun setup in the target repository.';
  writeFailureMarker(markerFile, diagnostic);
  return false;
}

function ensureGraphify() {
  return ensureCli('graphify', 'graphifyy[all]', '.graphify-install-failed');
}

module.exports = {
  CRG_PACKAGE,
  CRG_VERSIONED_RUNTIME_DIR,
  INSTALL_COMMAND_TIMEOUT_MS,
  INSTALL_LOCK_WAIT_MS,
  MCP_BOOTSTRAP_BUDGET_MS,
  MCP_BOOTSTRAP_RESERVE_MS,
  MCP_STARTUP_TIMEOUT_SEC,
  crgRuntimePaths,
  pythonCandidates,
  pipInstall,
  probeCrgRuntime,
  installManagedCrg,
  ensureCli,
  ensureCrg,
  acquireInstallLock,
  releaseInstallLock,
  ensureGraphify,
};
