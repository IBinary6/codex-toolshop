'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MIN_MAJOR = 3;
const MIN_MINOR = 11;
// A cold interpreter start (first run after boot, antivirus scanning) can exceed one second.
const PYTHON_DETECTION_TIMEOUT_MS = 4000;
const PYTHON_CANDIDATE_TIMEOUT_MS = 3000;
const CACHE_FILE_NAME = 'python-runtime.json';
// Versioned names cover Homebrew/python.org installs that do not own the bare python3 name (stock macOS ships 3.9).
const VERSIONED_NAMES = ['python3.14', 'python3.13', 'python3.12', 'python3.11'];
const RUNTIME_ENV_NAMES = ['LOCAL_KNOWLEDGE_PYTHON', 'BUGDB_PYTHON'];
const VERSION_SCRIPT = 'import sys; print("%d.%d.%d" % sys.version_info[:3])';

function newestFirst(left, right) {
  /** Order uv interpreter folder names such as `cpython-3.12.4-...` by version, newest first. */
  const version = (name) => (name.match(/^cpython-(\d+)\.(\d+)(?:\.(\d+))?/) || []).slice(1).map(Number);
  const a = version(left);
  const b = version(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (b[index] || 0) - (a[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function uvManagedPythons(environment, platform) {
  /** List uv-managed interpreters newest first without starting uv; return [] when none exist. */
  const roots = [];
  if (environment.UV_PYTHON_INSTALL_DIR) roots.push(environment.UV_PYTHON_INSTALL_DIR);
  if (platform === 'win32') {
    roots.push(path.join(environment.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'uv', 'python'));
  } else {
    roots.push(path.join(environment.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'uv', 'python'));
  }
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (_) { continue; }
    for (const entry of entries.filter((name) => /^cpython-3\.\d+/.test(name)).sort(newestFirst)) {
      found.push(platform === 'win32'
        ? path.join(root, entry, 'python.exe')
        : path.join(root, entry, 'bin', 'python3'));
    }
  }
  return found;
}

function pythonCandidates(environment = process.env, platform = process.platform,
  envNames = RUNTIME_ENV_NAMES) {
  /**
   * Return Python candidates for the platform; explicit variables contain executable paths and are not shell-parsed.
   *
   * Example: `pythonCandidates({}, 'win32')` starts with `python`, `python3`, then `py -3`.
   */
  for (const name of envNames) {
    const configured = String(environment[name] || '').trim();
    if (configured) return [{ command: configured, args: [] }];
  }
  const names = platform === 'win32'
    ? [{ command: 'python', args: [] }, { command: 'python3', args: [] },
      { command: 'py', args: ['-3'] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] },
      ...VERSIONED_NAMES.map((command) => ({ command, args: [] }))];
  const directories = platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/Library/Frameworks/Python.framework/Versions/Current/bin']
    : platform === 'win32' ? [] : ['/usr/local/bin', '/usr/bin'];
  const absolute = [];
  for (const directory of directories) {
    for (const name of ['python3', ...VERSIONED_NAMES]) absolute.push(`${directory}/${name}`);
  }
  absolute.push(...uvManagedPythons(environment, platform));
  return [...names, ...absolute.map((command) => ({ command, args: [] }))];
}

function cachePath(environment = process.env) {
  /**
   * Remember the interpreter that was verified last time in the plugin data directory the host injects, so the
   * next hook can try it first. Without PLUGIN_DATA (tests, manual runs) nothing is cached or written.
   */
  return environment.PLUGIN_DATA ? path.join(environment.PLUGIN_DATA, CACHE_FILE_NAME) : null;
}

function readCache(file) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof cached.command === 'string' && Array.isArray(cached.args)) return cached;
  } catch (_) {}
  return null;
}

function writeCache(file, candidate) {
  // A torn write only means the next hook reads invalid JSON and searches again, so no temporary file is needed.
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ command: candidate.command, args: candidate.args }));
  } catch (_) {}
}

function parseVersion(output) {
  /**
   * Parse stdout from the version probe.
   *
   * Example: `parseVersion('3.12.1\n')` returns three numbers and the original version text.
   */
  const match = String(output || '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: match[0],
  };
}

function isSupported(version) {
  /**
   * Check whether a parsed version meets Python 3.11+.
   *
   * Example: Python 3.11.0 passes; Python 3.10.9 fails.
   */
  return version.major > MIN_MAJOR
    || (version.major === MIN_MAJOR && version.minor >= MIN_MINOR);
}

function isNewer(left, right) {
  /** Compare parsed versions to retain the most informative unsupported version. */
  if (!right) return true;
  const leftParts = [left.major, left.minor, left.patch];
  const rightParts = [right.major, right.minor, right.patch];
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index];
  }
  return false;
}

function resolvePython(options = {}) {
  /**
   * Probe candidates in order and return the first Python 3.11+; older versions do not stop further probing.
   * The interpreter verified last time, when the host provides a plugin data directory, is probed first.
   *
   * Example: `resolvePython()` returns command and args suitable for `spawnSync`.
   */
  const environment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const envNames = options.envNames || RUNTIME_ENV_NAMES;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const timeout = options.timeout ?? PYTHON_DETECTION_TIMEOUT_MS;
  const candidateTimeout = options.candidateTimeout ?? PYTHON_CANDIDATE_TIMEOUT_MS;
  const configured = envNames.some((name) => String(environment[name] || '').trim());
  // cacheFile: undefined = default policy, null = disabled, string = explicit file (tests).
  const cacheFile = options.cacheFile !== undefined ? options.cacheFile
    : (configured ? null : cachePath(environment));
  const cached = cacheFile ? readCache(cacheFile) : null;
  const startedAt = Date.now();
  let newestUnsupported = null;

  function* candidates() {
    // The full list is built only if the remembered interpreter does not answer first.
    if (cached) yield cached;
    yield* pythonCandidates(environment, platform, envNames);
  }

  for (const candidate of candidates()) {
    const remaining = timeout - (Date.now() - startedAt);
    if (remaining <= 0) break;
    const result = spawnSyncImpl(candidate.command,
      [...candidate.args, '-c', VERSION_SCRIPT], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: platform === 'win32',
        timeout: Math.max(1, Math.min(candidateTimeout, remaining)),
      });
    if (!result || result.error || result.status !== 0) continue;
    const parsed = parseVersion(result.stdout);
    if (!parsed) continue;
    if (isSupported(parsed)) {
      if (cacheFile && candidate !== cached) writeCache(cacheFile, candidate);
      return { ok: true, command: candidate.command, args: [...candidate.args],
        version: parsed.version, elapsedMs: Date.now() - startedAt };
    }
    if (isNewer(parsed, newestUnsupported)) newestUnsupported = parsed;
  }
  return { ok: false, version: newestUnsupported ? newestUnsupported.version : null,
    elapsedMs: Date.now() - startedAt };
}

function main() {
  /** Validate Python, then transparently run the supplied arguments for npm, skills, and manual diagnostics. */
  const runtime = resolvePython();
  if (!runtime.ok) {
    const detail = runtime.version
      ? `highest detected version is Python ${runtime.version}`
      : 'no usable Python was found';
    process.stderr.write(`Local Knowledge requires Python 3.11+; ${detail}.\n`);
    process.exitCode = 1;
    return;
  }
  const result = spawnSync(runtime.command, [...runtime.args, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: 'inherit',
    windowsHide: process.platform === 'win32',
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) main();

module.exports = {
  PYTHON_DETECTION_TIMEOUT_MS,
  RUNTIME_ENV_NAMES,
  cachePath,
  pythonCandidates,
  resolvePython,
};
