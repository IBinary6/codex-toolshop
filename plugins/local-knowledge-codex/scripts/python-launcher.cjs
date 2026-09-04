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
   * 返回当前平台的 Python 候选；显式变量保存可执行文件路径，不经 shell 解析。
   *
   * Example: `pythonCandidates({}, 'win32')` 的最后一个候选是 `py -3`。
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
   * 解析版本探测的标准输出。
   *
   * Example: `parseVersion('3.12.1\n')` 返回三个数值和原始版本文本。
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
   * 判断解析后的版本是否满足 Python 3.11+。
   *
   * Example: Python 3.11.0 通过，Python 3.10.9 不通过。
   */
  return version.major > MIN_MAJOR
    || (version.major === MIN_MAJOR && version.minor >= MIN_MINOR);
}

function isNewer(left, right) {
  /** 比较两个已解析版本，用于保留最有诊断价值的过低版本。 */
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
   * 逐个验证候选并返回第一个 Python 3.11+，低版本不会阻断后续探测。
   *
   * Example: `resolvePython()` 返回可直接交给 `spawnSync` 的 command/args。
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
  /** 验证 Python 后透明执行传入参数，供 npm、skill 和人工诊断共同复用。 */
  const runtime = resolvePython();
  if (!runtime.ok) {
    const detail = runtime.version
      ? `检测到的最高版本为 Python ${runtime.version}`
      : '未检测到可用的 Python';
    process.stderr.write(`Local Knowledge 需要 Python 3.11+；${detail}。\n`);
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
