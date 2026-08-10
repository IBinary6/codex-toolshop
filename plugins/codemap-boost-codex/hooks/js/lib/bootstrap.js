'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isWindows, markerPath, pluginDataDir, writeMarker } = require('./runtime');
const { commandExists } = require('./runtime');

const CRG_PACKAGE = 'code-review-graph[all]';
const CRG_RUNTIME_DIR = 'crg-runtime';
const CRG_PYTHON_VERSION = '3.12';
const INSTALL_LOCK_WAIT_MS = 9 * 60 * 1000;
const INSTALL_LOCK_BOOT_MS = 5000;

function pythonCandidates() {
  const candidates = [];
  if (process.env.CODEMAP_BOOST_PYTHON) {
    const args = (process.env.CODEMAP_BOOST_PYTHON_ARGS || '').trim().split(/\s+/).filter(Boolean);
    candidates.push([process.env.CODEMAP_BOOST_PYTHON, args]);
  }
  if (isWindows) {
    candidates.push(['py', ['-3.12']]);
    candidates.push(['py', ['-3.11']]);
  }
  candidates.push(['python3.12', []]);
  candidates.push(['python3.11', []]);
  candidates.push(['python', []]);
  candidates.push(['python3', []]);
  if (isWindows) candidates.push(['py', ['-3']]);
  return candidates;
}

function pipInstall(pkg) {
  for (const [py, baseArgs] of pythonCandidates()) {
    try {
      const result = spawnSync(
        py,
        [...baseArgs, '-m', 'pip', 'install', '--disable-pip-version-check', pkg],
        { stdio: 'ignore', timeout: 300000, windowsHide: isWindows }
      );
      if (!result.error && result.status === 0) return true;
    } catch (_) {}
  }
  return false;
}

/**
 * 返回插件私有 CRG 运行环境的绝对路径。
 * @example crgRuntimePaths().command
 */
function crgRuntimePaths(options = {}) {
  const dir = path.resolve(options.runtimeDir || path.join(pluginDataDir(), CRG_RUNTIME_DIR));
  const binDir = path.join(dir, isWindows ? 'Scripts' : 'bin');
  return {
    dir,
    python: path.join(binDir, isWindows ? 'python.exe' : 'python'),
    command: path.join(binDir, isWindows ? 'code-review-graph.exe' : 'code-review-graph'),
  };
}

function recordDiagnostic(options, message) {
  if (Array.isArray(options.diagnostics)) options.diagnostics.push(String(message));
}

function errorSummary(error) {
  if (!error) return '未知错误';
  return String(error.code || error.message || error);
}

function runOk(command, args, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const label = options.diagnosticLabel || command;
  try {
    const result = spawn(command, args, {
      encoding: 'utf8',
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout || 300000,
      windowsHide: isWindows,
    });
    if (result && !result.error && result.status === 0) return true;
    const reason = result && result.error
      ? errorSummary(result.error)
      : `退出码 ${result && result.status !== undefined ? result.status : '未知'}`;
    recordDiagnostic(options, `${label} 失败：${reason}`);
    return false;
  } catch (error) {
    recordDiagnostic(options, `${label} 异常：${errorSummary(error)}`);
    return false;
  }
}

/**
 * 用上游同款 `python -I -B` 模式验证 CLI 与四类 parser，避免探针写入 pycache。
 * @example probeCrgRuntime({ runtimeDir: 'C:\\plugin-data\\crg-runtime' })
 */
function probeCrgRuntime(options = {}) {
  const paths = crgRuntimePaths(options);
  const exists = options.pathExists || fs.existsSync;
  const probeOptions = { ...options, timeout: options.probeTimeout || 15000 };
  try {
    if (!exists(paths.python)) {
      recordDiagnostic(options, `managed Python 不存在：${paths.python}`);
      return false;
    }
    if (!exists(paths.command)) {
      recordDiagnostic(options, `managed CRG 不存在：${paths.command}`);
      return false;
    }
    if (!runOk(paths.command, ['--version'], {
      ...probeOptions,
      diagnosticLabel: 'managed CRG 版本探针',
    })) return false;
    const parserProbe = [
      'from tree_sitter_language_pack import get_parser',
      "for grammar in ('python', 'javascript', 'typescript', 'tsx'):",
      '    get_parser(grammar)',
    ].join('\n');
    return runOk(paths.python, ['-I', '-B', '-c', parserProbe], {
      ...probeOptions,
      diagnosticLabel: 'managed parser -I -B 探针',
    });
  } catch (error) {
    recordDiagnostic(options, `managed runtime 健康检查异常：${errorSummary(error)}`);
    return false;
  }
}

function removeManagedRuntime(runtimeDir) {
  try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * 在插件数据目录重建隔离 venv，并只向其中安装 CRG。
 * @example installManagedCrg('code-review-graph[all]')
 */
function installManagedCrg(pkg = CRG_PACKAGE, options = {}) {
  const paths = crgRuntimePaths(options);
  const exists = options.pathExists || fs.existsSync;
  const uvProbe = options.uvProbe || commandExists;
  const candidates = options.pythonCandidates || pythonCandidates;
  const probe = options.probeRuntime || probeCrgRuntime;
  const pythonVersion = process.env.CODEMAP_BOOST_PYTHON_VERSION || CRG_PYTHON_VERSION;

  // 只有健康检查失败才会进入安装；清理损坏的插件私有运行时后再重建。
  removeManagedRuntime(paths.dir);

  let uvAvailable = false;
  try {
    uvAvailable = !!uvProbe('uv');
  } catch (error) {
    recordDiagnostic(options, `uv 检测异常：${errorSummary(error)}`);
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
        recordDiagnostic(options, `uv 安装后健康检查异常：${errorSummary(error)}`);
      }
      if (healthy) return true;
    } else if (created) {
      recordDiagnostic(options, `uv venv 未生成 managed Python：${paths.python}`);
    }
    removeManagedRuntime(paths.dir);
  }

  let pythonList = [];
  try { pythonList = candidates(); } catch (error) {
    recordDiagnostic(options, `Python 候选检测异常：${errorSummary(error)}`);
  }
  for (const [python, baseArgs] of pythonList) {
    const created = runOk(python, [...baseArgs, '-m', 'venv', paths.dir], {
      ...options,
      diagnosticLabel: `${python} venv`,
    });
    if (!created || !exists(paths.python)) {
      if (created) recordDiagnostic(options, `${python} venv 未生成 managed Python：${paths.python}`);
      removeManagedRuntime(paths.dir);
      continue;
    }
    const installed = runOk(paths.python, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', pkg,
    ], { ...options, diagnosticLabel: `${python} venv pip install` });
    let healthy = false;
    try { healthy = installed && !!probe(options); } catch (error) {
      recordDiagnostic(options, `${python} 安装后健康检查异常：${errorSummary(error)}`);
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
 * 在短暂轮询间隔内同步等待，不启动额外 shell 进程。
 * @example sleepSync(100)
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 检查锁文件记录的本机进程是否仍存活。
 * @example isPidAlive(process.pid)
 */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 获取私有运行时安装锁，避免并发任务同时重建同一个 venv。
 * @example acquireInstallLock('/tmp/crg-runtime.install.lock')
 */
function acquireInstallLock(file, options = {}) {
  const waitMs = options.installLockWaitMs || INSTALL_LOCK_WAIT_MS;
  const bootMs = options.installLockBootMs || INSTALL_LOCK_BOOT_MS;
  const deadline = Date.now() + waitMs;
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
      // 活进程的安装不能仅因耗时较长而被抢锁，否则两个任务会同时重建 venv。
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
 * 释放当前任务持有的私有运行时安装锁。
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
  const lastFailure = '安装器返回失败或安装后仍找不到命令';
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
  const diagnostic = `${command} 不可用；已尝试 ${attempted.join('、')}，最后结果：${lastFailure}。请安装 ${pkg} 后重新运行 setup。`;
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
 * 确保插件私有运行环境健康；失败时写入可操作的诊断 marker。
 * @example ensureCrg()
 */
function ensureCrg(options = {}) {
  const probe = options.probeRuntime || probeCrgRuntime;
  const install = options.installRuntime || installManagedCrg;
  const markerFile = options.markerPath || markerPath('.crg-install-failed');
  const diagnostics = Array.isArray(options.diagnostics) ? options.diagnostics : [];
  const runtimeOptions = { ...options, diagnostics };
  const clearMarker = () => {
    try { fs.rmSync(markerFile, { force: true }); } catch (_) {}
  };
  let healthy = false;
  try { healthy = !!probe(runtimeOptions); } catch (error) {
    recordDiagnostic(runtimeOptions, `初始健康检查异常：${errorSummary(error)}`);
  }
  if (healthy) {
    clearMarker();
    return true;
  }
  const lockFile = options.installLockPath || `${crgRuntimePaths(options).dir}.install.lock`;
  const acquire = options.acquireInstallLock || acquireInstallLock;
  const release = options.releaseInstallLock || releaseInstallLock;
  let lockToken = null;
  try {
    lockToken = acquire(lockFile, runtimeOptions);
    if (!lockToken) recordDiagnostic(runtimeOptions, `等待私有运行环境安装锁超时：${lockFile}`);
  } catch (error) {
    recordDiagnostic(runtimeOptions, `获取私有运行环境安装锁异常：${errorSummary(error)}`);
  }
  if (lockToken) {
    try {
      // 等锁期间另一任务可能已经完成安装，必须先复查再决定是否重建。
      try { healthy = !!probe(runtimeOptions); } catch (error) {
        recordDiagnostic(runtimeOptions, `加锁后健康检查异常：${errorSummary(error)}`);
      }
      let installed = false;
      if (!healthy) {
        try { installed = !!install(CRG_PACKAGE, runtimeOptions); } catch (error) {
          recordDiagnostic(runtimeOptions, `隔离运行环境安装异常：${errorSummary(error)}`);
        }
        try { healthy = installed && !!probe(runtimeOptions); } catch (error) {
          recordDiagnostic(runtimeOptions, `安装后健康检查异常：${errorSummary(error)}`);
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
  const detail = [...new Set(diagnostics)].slice(-6).join('；');
  const diagnostic = 'code-review-graph 插件隔离运行环境安装或 parser 健康检查失败。'
    + (detail ? `诊断：${detail}。` : '')
    + '不要使用 pip --user/user-site 修补；请在目标仓库重新运行 setup。';
  writeFailureMarker(markerFile, diagnostic);
  return false;
}

function ensureGraphify() {
  return ensureCli('graphify', 'graphifyy[all]', '.graphify-install-failed');
}

module.exports = {
  CRG_PACKAGE,
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
