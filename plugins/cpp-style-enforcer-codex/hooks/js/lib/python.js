'use strict';

const { spawnSync: defaultSpawnSync } = require('node:child_process');

const PYTHON3_PROBE = 'import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)';
const PYTHON_PROBE_TIMEOUT_MS = 3000;
let cachedPythonResolved = false;
let cachedPython = null;

/**
 * 将环境变量中的启动参数拆成参数数组。
 *
 * @param {string|undefined} value 空白分隔的参数文本
 * @returns {string[]} 启动参数
 * @example
 * splitArgs('-3 -X utf8') // ['-3', '-X', 'utf8']
 */
function splitArgs(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}

/**
 * 生成当前平台的 Python 候选；Windows Launcher 使用 `py -3`，不绑定小版本。
 *
 * @param {{platform?:string, env?:object}} [options]
 * @returns {Array<{cmd:string,args:string[]}>} 按探测顺序排列的候选
 * @example
 * pythonCandidates({ platform: 'win32', env: {} })
 */
function pythonCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (env.CPP_STYLE_PYTHON) {
    return [{ cmd: env.CPP_STYLE_PYTHON, args: splitArgs(env.CPP_STYLE_PYTHON_ARGS) }];
  }
  return platform === 'win32'
    ? [
        { cmd: 'py', args: ['-3'] },
        { cmd: 'python', args: [] },
        { cmd: 'python3', args: [] },
      ]
    : [
        { cmd: 'python3', args: [] },
        { cmd: 'python', args: [] },
      ];
}

/**
 * 验证单个启动描述是否能运行 Python 3；命令缺失、超时或 Python 2 均返回 false。
 *
 * @param {{cmd:string,args:string[]}} candidate Python 启动描述
 * @param {{platform?:string, spawnSync?:Function}} [options]
 * @returns {boolean} 是否为可运行的 Python 3
 * @example
 * probePython3({ cmd: 'python3', args: [] })
 */
function probePython3(candidate, options = {}) {
  const platform = options.platform || process.platform;
  const spawn = options.spawnSync || defaultSpawnSync;
  try {
    const result = spawn(candidate.cmd, [...candidate.args, '-c', PYTHON3_PROBE], {
      stdio: 'pipe',
      timeout: PYTHON_PROBE_TIMEOUT_MS,
      windowsHide: platform === 'win32',
    });
    return !result.error && result.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * 探测并返回所有可运行的 Python 3 启动描述；缺失命令和 Python 2 都会被跳过。
 *
 * @param {{platform?:string, env?:object, spawnSync?:Function, candidates?:Array<{cmd:string,args:string[]}>}} [options]
 * @returns {Array<{cmd:string,args:string[]}>} 已验证为 Python 3 的候选
 * @example
 * resolvePythonCandidates()[0] // { cmd: 'python3', args: [] }
 */
function resolvePythonCandidates(options = {}) {
  const candidates = options.candidates || pythonCandidates(options);
  return candidates.filter((candidate) => probePython3(candidate, options));
}

/**
 * 返回第一个已验证的 Python 3 启动描述，全部不可用时返回 null。
 *
 * @param {{platform?:string, env?:object, spawnSync?:Function, candidates?:Array<{cmd:string,args:string[]}>}} [options]
 * @returns {{cmd:string,args:string[]}|null} Python 3 启动描述
 * @example
 * const python = resolvePython();
 * if (python) console.log(python.cmd);
 */
function resolvePython(options = {}) {
  const useCache = options.useCache === true || Object.keys(options).length === 0;
  if (useCache && cachedPythonResolved) return cachedPython;
  const candidates = options.candidates || pythonCandidates(options);
  for (const candidate of candidates) {
    if (probePython3(candidate, options)) {
      if (useCache) {
        cachedPythonResolved = true;
        cachedPython = candidate;
      }
      return candidate;
    }
  }
  if (useCache) cachedPythonResolved = true;
  return null;
}

/**
 * 清空进程内 Python 探测缓存，仅供确定性测试使用。
 * @returns {void}
 */
function resetPythonCacheForTests() {
  cachedPythonResolved = false;
  cachedPython = null;
}

module.exports = {
  PYTHON3_PROBE,
  PYTHON_PROBE_TIMEOUT_MS,
  pythonCandidates,
  resetPythonCacheForTests,
  resolvePython,
  resolvePythonCandidates,
};
