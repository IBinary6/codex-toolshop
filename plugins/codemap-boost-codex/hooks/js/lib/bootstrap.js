'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isWindows, markerPath, writeMarker } = require('./runtime');
const { commandExists } = require('./runtime');

function pythonCandidates() {
  const candidates = [];
  if (process.env.CODEMAP_BOOST_PYTHON) {
    const args = (process.env.CODEMAP_BOOST_PYTHON_ARGS || '').trim().split(/\s+/).filter(Boolean);
    candidates.push([process.env.CODEMAP_BOOST_PYTHON, args]);
  }
  if (isWindows) {
    candidates.push(['py', ['-3.11']]);
    candidates.push(['py', ['-3']]);
  }
  candidates.push(['python', []]);
  candidates.push(['python3', []]);
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

function uvToolInstall(pkg) {
  try {
    const result = spawnSync(
      'uv',
      ['tool', 'install', '--upgrade', pkg],
      { stdio: 'ignore', timeout: 300000, windowsHide: isWindows }
    );
    return !result.error && result.status === 0;
  } catch (_) {
    return false;
  }
}

function writeFailureMarker(file, diagnostic) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${diagnostic}\n`, 'utf8');
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

function ensureCrg(options = {}) {
  const probe = options.probe || commandExists;
  const uvProbe = options.uvProbe || commandExists;
  const uvInstall = options.uvInstall || uvToolInstall;
  const install = options.install || pipInstall;
  const installers = [];
  if (uvProbe('uv')) installers.push({ name: 'uv tool install', install: uvInstall });
  installers.push({ name: 'pip', install });
  return ensureCli('code-review-graph', 'code-review-graph[all]', '.crg-install-failed', {
    ...options,
    probe,
    installers,
  });
}

function ensureGraphify() {
  return ensureCli('graphify', 'graphifyy[all]', '.graphify-install-failed');
}

module.exports = {
  pythonCandidates,
  pipInstall,
  uvToolInstall,
  ensureCli,
  ensureCrg,
  ensureGraphify,
};
