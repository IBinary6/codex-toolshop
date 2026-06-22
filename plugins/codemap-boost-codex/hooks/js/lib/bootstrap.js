'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isWindows, markerExists, markerPath, writeMarker } = require('./runtime');
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

function localMarkerExists(file) {
  try { return fs.existsSync(file); } catch (_) { return false; }
}

function localWriteMarker(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '1');
  } catch (_) {}
}

function ensureCli(command, pkg, marker, opts = {}) {
  const probe = opts.probe || commandExists;
  const install = opts.install || pipInstall;
  const markerFile = opts.markerPath || markerPath(marker);
  const hasMarker = opts.markerPath ? localMarkerExists(markerFile) : markerExists(marker);
  if (probe(command)) return true;
  if (hasMarker) return false;
  if (install(pkg) && probe(command)) return true;
  if (opts.markerPath) localWriteMarker(markerFile);
  else writeMarker(marker);
  return false;
}

function ensureCrg() {
  return ensureCli('code-review-graph', 'code-review-graph[all]', '.crg-install-failed');
}

function ensureGraphify() {
  return ensureCli('graphify', 'graphifyy[all]', '.graphify-install-failed');
}

module.exports = {
  pythonCandidates,
  pipInstall,
  ensureCli,
  ensureCrg,
  ensureGraphify,
};
