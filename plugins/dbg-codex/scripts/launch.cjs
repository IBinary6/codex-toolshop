#!/usr/bin/env node
'use strict';

// Plugin, terminal, and MCP share this entry point; scripts make all installation decisions.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { pythonCandidates: sharedCandidates } = require('./_shared/python-candidates.cjs');
const { LazyMcp } = require('./lazy_mcp.cjs');
const UV_VERSION = '0.12.10';
const BACKENDS = ['x64dbg', 'x32dbg', 'ghidra', 'windbg', 'ida-mcp'];

function dataDir(env = process.env, platform = process.platform) {
  if (env.DBG_HOME) return path.resolve(env.DBG_HOME);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Dbg');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Dbg');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'dbg');
}

const BOOTSTRAP_LOCK_WAIT_MS = 15 * 60 * 1000;
const BOOTSTRAP_LOCK_STALE_MS = 30 * 60 * 1000;

function pythonCandidates(env = process.env, platform = process.platform) {
  const explicit = env.DBG_PYTHON ? [[env.DBG_PYTHON]] : [];
  const found = sharedCandidates({ platform, env, minMinor: 11, includeUv: false });
  return [...explicit, ...found.map(({ command, args }) => [command, ...args])];
}

function findPython(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const run = options.run || spawnSync;
  for (const candidate of [...pythonCandidates(env, platform), ...(options.extra || [])]) {
    const query = 'import sys; print(str(sys.version_info.major)+"."+str(sys.version_info.minor))' +
      (options.absolute ? '; print(sys.executable)' : '');
    const result = run(candidate[0], [...candidate.slice(1), '-c', query], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, env,
    });
    if (result.error || result.status !== 0) continue;
    const [version, executable] = String(result.stdout || '').trim().split(/\r?\n/);
    const match = version.match(/^(\d+)\.(\d+)$/);
    if (!match || Number(match[1]) < 3 || Number(match[1]) === 3 && Number(match[2]) < 11) continue;
    if (!options.absolute) return candidate;
    if (isFile(executable)) return [executable];
  }
  return null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Windows refuses to create or remove a directory whose deletion is still completing (another process, a virus scanner
// or the search indexer holds a handle for a moment) with EPERM, EACCES or EBUSY. That is contention, not a failure.
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const TRANSIENT_FS_GRACE_MS = 2000;

/** Remove a directory tree, retrying for about 200 ms while Windows still holds it; returns whether it is gone. */
function removeDirectory(target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (attempt >= 10 || !TRANSIENT_FS_CODES.has(error.code)) return false;
      sleepSync(20);
    }
  }
}

/**
 * Remove a lock left behind by a crashed process. A lock is abandoned when its recorded owner is gone, or when it
 * is older than staleMs. Only one waiter at a time may judge and remove it: the guard directory serializes the
 * check-and-remove, so a waiter can never delete a lock that another waiter has just reclaimed and re-taken.
 * Returns true when the caller should try to take the lock again right away.
 */
function reclaimAbandonedLock(lockDir, staleMs) {
  const guard = `${lockDir}.reclaim`;
  try {
    fs.mkdirSync(guard);
  } catch (error) {
    if (error.code !== 'EEXIST' && !TRANSIENT_FS_CODES.has(error.code)) throw error;
    // The guard is held for a few milliseconds; one older than a minute belongs to a process that died inside it.
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > 60 * 1000) removeDirectory(guard);
    } catch (_) {}
    return false;
  }
  try {
    let ageMs;
    try {
      ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
    } catch (error) {
      return error.code === 'ENOENT'; // released in the meantime: take it now; anything else: keep waiting
    }
    let owner = 0;
    try { owner = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')); } catch (_) {}
    const ownerGone = owner > 0 && !pidAlive(owner);
    if (!ownerGone && ageMs <= staleMs) return false;
    return removeDirectory(lockDir); // still held by another process: keep waiting
  } finally {
    removeDirectory(guard);
  }
}

/**
 * Serialize first-run bootstrap across the five MCP servers and the SessionStart hook.
 * mkdir is atomic on every platform; the owner's pid lets waiters recover at once from a killed process.
 */
function withBootstrapLock(lockDir, fn, options = {}) {
  const waitMs = options.waitMs ?? BOOTSTRAP_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? BOOTSTRAP_LOCK_STALE_MS;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + waitMs;
  const graceMs = options.transientGraceMs ?? TRANSIENT_FS_GRACE_MS;
  let transientSince = 0;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code === 'EEXIST') {
        transientSince = 0;
      } else if (TRANSIENT_FS_CODES.has(error.code)) {
        // A name that is still being deleted frees up in a moment; a refusal that lasts is a real error.
        transientSince = transientSince || Date.now();
        if (Date.now() - transientSince > graceMs) throw error;
        sleepSync(25);
        continue;
      } else {
        throw error;
      }
    }
    if (Date.now() > deadline) throw new Error('Runtime preparation failed: another Dbg process is still preparing Python');
    if (!reclaimAbandonedLock(lockDir, staleMs)) sleepSync(250);
  }
  try {
    try { fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid)); } catch (_) {}
    return fn();
  } finally {
    removeDirectory(lockDir);
  }
}

function managedPythonRecord() {
  return path.join(dataDir(), 'bootstrap', 'python-path.txt');
}

function recordedPython() {
  try {
    const recorded = fs.readFileSync(managedPythonRecord(), 'utf8').trim();
    return recorded && fs.existsSync(recorded) ? [[recorded]] : [];
  } catch (_) {
    return [];
  }
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 600000, ...options });
  if (result.error || result.status !== 0) throw new Error(`Runtime preparation failed: ${path.basename(command)} (${result.error ? result.error.code : result.status})`);
  return String(result.stdout || '').trim();
}

function ensurePython(options = {}) {
  const find = () => findPython({ extra: recordedPython(), absolute: options.absolute });
  // Another process may have finished the bootstrap while this one waited for the lock.
  return find() || withBootstrapLock(path.join(dataDir(), 'bootstrap', 'install.lock'), () => find() || installManagedPython());
}

function installManagedPython() {
  let uv = 'uv';
  const probe = spawnSync(uv, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (probe.error || probe.status !== 0) {
    const installDir = path.join(dataDir(), 'bootstrap', 'uv');
    fs.mkdirSync(installDir, { recursive: true });
    uv = path.join(installDir, process.platform === 'win32' ? 'uv.exe' : 'uv');
    if (!fs.existsSync(uv)) {
      const filename = process.platform === 'win32' ? 'install.ps1' : 'install.sh';
      const installer = path.join(installDir, filename);
      checked('curl', ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '20', '--max-time', '180',
        '--output', installer, `https://astral.sh/uv/${UV_VERSION}/${filename}`]);
      const env = { ...process.env, UV_UNMANAGED_INSTALL: installDir, UV_NO_MODIFY_PATH: '1' };
      if (process.platform === 'win32') checked(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer], { env });
      else checked('/bin/sh', [installer], { env });
      if (!fs.existsSync(uv)) throw new Error('uv installation did not produce the expected isolated runtime');
    }
  }
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(dataDir(), 'bootstrap', 'python') };
  checked(uv, ['python', 'install', '3.12'], { env });
  const python = checked(uv, ['python', 'find', '--managed-python', '3.12'], { env });
  if (!fs.existsSync(python)) throw new Error('Python prepared by uv was not found');
  try { fs.writeFileSync(managedPythonRecord(), `${python}\n`); } catch (_) {}
  return [python];
}

function doctor(python, args) {
  return spawnSync(python[0], [...python.slice(1), path.join(__dirname, 'doctor.py'), 'doctor', ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 1200000,
    env: { ...process.env, DBG_NODE: process.execPath, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
}

function readObject(filename) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (_) {}
  return null;
}

function fileStamp(filename, allowWinDbgAlias = false) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) return null;
  try {
    const stat = fs.statSync(filename);
    return stat.isFile() ? [stat.size, stat.mtimeMs, stat.ctimeMs] : null;
  } catch (error) {
    // libuv cannot follow the official WindowsApps execution alias, although Windows can launch it.
    // Ordinary missing files and broken links still invalidate the deployment.
    if (process.platform !== 'win32' || !allowWinDbgAlias || error.code !== 'EACCES' || !isWinDbgExecutionAlias(filename)) return null;
    try {
      fs.accessSync(filename);
      const link = fs.lstatSync(filename);
      return link.isSymbolicLink() ? [link.size, link.mtimeMs, link.ctimeMs] : null;
    } catch (_) { return null; }
  }
}

function isWinDbgExecutionAlias(filename) {
  const parent = path.dirname(filename.toLowerCase());
  const folder = path.basename(parent);
  return path.basename(filename).toLowerCase() === 'dbgx.mcp.proxy.exe' &&
    (folder === 'windowsapps' || folder === 'microsoft.windbg_8wekyb3d8bbwe' &&
      path.basename(path.dirname(parent)) === 'windowsapps');
}

function isFile(filename) {
  return fileStamp(filename) !== null;
}

function pluginVersion() {
  return readObject(path.join(__dirname, '..', '.codex-plugin', 'plugin.json'))?.version;
}

function deployment(home, version, backend) {
  const state = readObject(path.join(home, 'state.json')) || {};
  const configFile = path.join(home, 'config.json');
  const config = readObject(configFile);
  const tool = backend === 'x32dbg' ? 'x64dbg' : backend;
  const record = state.tools?.[tool];
  const instance = backend === 'x32dbg' && Array.isArray(record?.instances)
    ? record.instances.find((item) => item.architecture === 'x32') : null;
  const mode = config?.windbg?.backend ?? 'auto';
  const runtime = backend === 'x32dbg' ? instance?.runtime
    : tool === 'windbg' && mode === 'legacy' && record?.backend === 'native' ? record.legacy_runtime : record?.runtime;
  const disabled = Array.isArray(config?.disabled) && config.disabled.includes(tool);
  const status = record?.status;
  const native = tool === 'windbg' && record?.backend === 'native' && mode !== 'legacy';
  const files = [
    ...(Array.isArray(record?.files) ? record.files : []),
    ...(Array.isArray(runtime?.command) ? runtime.command.filter((part) => typeof part === 'string' && path.isAbsolute(part)) : []),
    ...(runtime?.type === 'http' ? [state.http_bridge_python] : []),
    ...(instance?.config ? [instance.config] : []),
  ];
  const stamps = files.map((file) => fileStamp(file, native && file === runtime?.command?.[0]));
  const legacyStamps = tool === 'windbg' && Array.isArray(record?.legacy_runtime?.command) ?
    [record.legacy_runtime.command[0], record.legacy_runtime.env?.CDB_PATH, record.legacy_runtime.env?.KD_PATH].map((file) => fileStamp(file)) : [];
  const ready = !!version && state.plugin_version === version && state.schema_version === 1 &&
    (config || !fs.existsSync(configFile)) && ['auto', 'native', 'legacy'].includes(mode) &&
    (state.auto_windbg_backend ?? 'auto') === mode &&
    (disabled || ['disabled', 'unsupported', 'not_installed'].includes(status) ||
      (status === 'deployed' && stamps.every(Boolean) &&
        (runtime?.type === 'http' || Array.isArray(runtime?.command) && runtime.command.length || backend === 'x32dbg')));
  const secrets = [runtime?.token, ...Object.entries(runtime?.env || {})
    .filter(([key, value]) => typeof value === 'string' && /(?:TOKEN|SECRET|PASSWORD|AUTHORIZATION|API_KEY)/i.test(key))
    .map(([, value]) => value)].filter((value) => typeof value === 'string');
  // The cache key covers deployment, configuration, external file replacement and the configured Python override.
  // State and config may contain credentials. Only their digest and the public MCP catalog reach disk.
  const fingerprint = createHash('sha256').update(JSON.stringify([
    version, backend, state.plugin_version, config, record, state.http_bridge_python, stamps, legacyStamps, process.env.DBG_PYTHON,
  ])).digest('hex');
  return { ready, state, cacheable: ready && !native, fingerprint, secrets,
    statusTool: ['x64dbg', 'x32dbg'].includes(backend) ? 'dbg_' + backend + '_status' : null };
}

function pythonRecord(home) {
  return path.join(home, 'bootstrap', 'mcp-python.json');
}

function deployedPython(home, state) {
  const override = process.env.DBG_PYTHON ?? '';
  const recorded = readObject(pythonRecord(home));
  if (recorded?.override === override && isFile(recorded.executable)) return [recorded.executable];
  if (override) return null;
  const candidate = [state.http_bridge_python, ...Object.values(state.runtimes || {})].find(isFile);
  return candidate ? [candidate] : null;
}

function rememberPython(home, python) {
  if (python.length !== 1 || !isFile(python[0])) return;
  const file = pythonRecord(home);
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ executable: python[0], override: process.env.DBG_PYTHON ?? '' }),
      { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (_) {
    // State runtimes remain available if this optional interpreter hint cannot be written.
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function runMcp(backend, options = {}) {
  if (!BACKENDS.includes(backend)) throw new Error('Unknown MCP backend');
  // Resolve relative configuration before leaving the plugin cache directory that the host may rename.
  if (process.env.DBG_HOME) process.env.DBG_HOME = path.resolve(process.env.DBG_HOME);
  if (process.env.DBG_PYTHON && /[\\/]/.test(process.env.DBG_PYTHON)) {
    process.env.DBG_PYTHON = path.resolve(process.env.DBG_PYTHON);
  }
  const home = path.resolve(options.dataDir || dataDir());
  fs.mkdirSync(home, { recursive: true });
  process.chdir(home);
  const version = pluginVersion();
  const snapshot = () => deployment(home, version, backend);
  return new LazyMcp({
    ...options,
    snapshot,
    cacheFile: path.join(home, 'mcp-catalog', backend + '.json'),
    launch() {
      const current = snapshot();
      let python = current.ready && deployedPython(home, current.state);
      if (!python) {
        python = (options.ensurePython || ensurePython)({ absolute: true });
        // MCP may start before SessionStart. Both coordinate through the same doctor lock.
        const setup = (options.doctor || doctor)(python, ['--auto']);
        if (setup.error) process.stderr.write('Dbg automatic deployment is incomplete; reporting current backend status.\n');
        if (setup.status === 0) rememberPython(home, python);
      }
      return (options.spawn || spawn)(python[0], [...python.slice(1), path.join(__dirname, 'managed_server.py'), backend], {
        cwd: home, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, DBG_HOME: home, DBG_MCP_OWNER_PID: String(process.pid), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
    },
  }).start();
}

const HOOK_FAILURE_MESSAGE = 'Dbg first deployment has incomplete items. Run dbg doctor to retry; see last-report.json in the Dbg data directory.';

function runHook(options = {}) {
  // A hook must never surface as a raw failure: report through systemMessage and always exit 0.
  try {
    const home = path.resolve(options.dataDir || dataDir());
    const version = pluginVersion();
    const current = deployment(home, version, 'windbg');
    if (current.ready && current.state.auto_completed_version === version &&
        currentCli(current.state.cli) &&
        BACKENDS.filter((backend) => backend !== 'windbg').every((backend) => deployment(home, version, backend).ready)) return;
    const python = (options.ensurePython || ensurePython)();
    const result = (options.doctor || doctor)(python, ['--auto', '--json']);
    if (!result.error && result.status === 0) return;
  } catch (_) {}
  (options.write || ((text) => process.stdout.write(text)))(JSON.stringify({ systemMessage: HOOK_FAILURE_MESSAGE }));
}

function currentCli(cli) {
  try {
    if (!isFile(cli?.target)) return false;
    const script = process.platform === 'win32' ? path.join(path.dirname(cli.target), 'dbg-cli.ps1') : cli.target;
    const content = fs.readFileSync(script, 'utf8');
    // Doctor must refresh the command if the plugin cache or Node executable moved.
    return content.includes(fs.realpathSync(__filename)) && content.includes(fs.realpathSync(process.execPath));
  } catch (_) { return false; }
}

function main(argv = process.argv.slice(2)) {
  const mode = argv[0] || 'doctor';
  if (!['doctor', 'mcp', 'hook'].includes(mode)) throw new Error('Usage: dbg doctor [--tool tool] [--json]');
  if (mode === 'mcp') return runMcp(argv[1]);
  if (mode === 'hook') return runHook();
  const python = ensurePython();
  const result = doctor(python, argv.slice(1));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) process.stderr.write(`Dbg execution failed: ${result.error.code}\n`);
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { dataDir, pythonCandidates, findPython, withBootstrapLock, ensurePython, runMcp, runHook, main };
