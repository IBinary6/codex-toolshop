'use strict';

const { spawnSync } = require('child_process');

const MIN_MAJOR = 3;
const MIN_MINOR = 11;
const PYTHON_DETECTION_TIMEOUT_MS = 2000;
const PYTHON_CANDIDATE_TIMEOUT_MS = 750;
const RUNTIME_ENV_NAMES = ['LOCAL_KNOWLEDGE_PYTHON', 'BUGDB_PYTHON'];
const VERSION_SCRIPT = 'import sys; print("%d.%d.%d" % sys.version_info[:3])';

function pythonCandidates(environment = process.env, platform = process.platform,
  envNames = RUNTIME_ENV_NAMES) {
  /**
   * Return Python candidates for the platform; explicit variables contain executable paths and are not shell-parsed.
   *
   * Example: the final candidate of `pythonCandidates({}, 'win32')` is `py -3`.
   */
  for (const name of envNames) {
    const configured = String(environment[name] || '').trim();
    if (configured) return [{ command: configured, args: [] }];
  }
  return platform === 'win32'
    ? [{ command: 'python', args: [] }, { command: 'python3', args: [] },
      { command: 'py', args: ['-3'] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
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
   *
   * Example: `resolvePython()` returns command and args suitable for `spawnSync`.
   */
  const environment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const envNames = options.envNames || RUNTIME_ENV_NAMES;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const timeout = options.timeout ?? PYTHON_DETECTION_TIMEOUT_MS;
  const candidateTimeout = options.candidateTimeout ?? PYTHON_CANDIDATE_TIMEOUT_MS;
  const startedAt = Date.now();
  let newestUnsupported = null;

  for (const candidate of pythonCandidates(environment, platform, envNames)) {
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
  pythonCandidates,
  resolvePython,
};
