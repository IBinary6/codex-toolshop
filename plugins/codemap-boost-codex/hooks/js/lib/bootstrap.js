'use strict';

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isWindows, markerExists, markerPath, writeMarker } = require('./runtime');
const { commandExists } = require('./runtime');
const { registerCrgMcp } = require('./codemap');

function pipInstall(pkg) {
  for (const py of ['python', 'python3']) {
    try {
      const result = spawnSync(
        py,
        ['-m', 'pip', 'install', '--disable-pip-version-check', pkg],
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

function spawnPrewarm() {
  if (process.env.CODEMAP_BOOST_DISABLE_BOOTSTRAP === '1') return null;
  try {
    const child = spawn(process.execPath, [__filename, '--prewarm'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      windowsHide: isWindows,
    });
    child.unref();
    return child;
  } catch (_) {
    return null;
  }
}

module.exports = {
  pipInstall,
  ensureCli,
  ensureCrg,
  ensureGraphify,
  spawnPrewarm,
};

if (require.main === module && process.argv.includes('--prewarm')) {
  try { ensureCrg(); } catch (_) {}
  try { ensureGraphify(); } catch (_) {}
  try { registerCrgMcp(); } catch (_) {}
  process.exit(0);
}
