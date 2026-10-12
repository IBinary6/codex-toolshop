'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const NEWEST_MINOR = 14;

/**
 * Order uv interpreter folder names such as `cpython-3.12.4-...` by version, newest first.
 * @example ['cpython-3.9.1-x', 'cpython-3.12.4-x'].sort(newestFirst) // 3.12.4 first
 */
function newestFirst(left, right) {
  const version = (name) => (name.match(/^cpython-(\d+)\.(\d+)(?:\.(\d+))?/) || []).slice(1).map(Number);
  const a = version(left);
  const b = version(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (b[index] || 0) - (a[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

/** List uv-managed interpreters newest first without starting uv; return [] when none exist. */
function uvManagedPythons(env, platform) {
  const roots = [];
  if (env.UV_PYTHON_INSTALL_DIR) roots.push(env.UV_PYTHON_INSTALL_DIR);
  roots.push(platform === 'win32'
    ? path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'uv', 'python')
    : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'uv', 'python'));
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (_) { continue; }
    for (const entry of entries.filter((name) => /^cpython-3\.\d+/.test(name)).sort(newestFirst)) {
      found.push(platform === 'win32' ? path.join(root, entry, 'python.exe') : path.join(root, entry, 'bin', 'python3'));
    }
  }
  return found;
}

/**
 * Candidate Python interpreters for a platform, best first. Fixed locations are plain POSIX strings, and a
 * candidate that does not exist simply fails to spawn, so callers just probe in order.
 * @param {object} options
 * @param {string} [options.platform]
 * @param {object} [options.env]
 * @param {number} options.minMinor lowest 3.x minor version the caller accepts; versioned names stop there
 * @param {string[]} [options.windowsNames] bare names tried first on Windows, in order
 * @param {boolean} [options.includeUv] also list interpreters managed by uv
 * @returns {Array<{command: string, args: string[]}>}
 * @example pythonCandidates({ platform: 'darwin', env: {}, minMinor: 11 })
 */
function pythonCandidates({ platform = process.platform, env = process.env, minMinor, windowsNames = ['python3', 'python'], includeUv = true }) {
  const versioned = [];
  for (let minor = NEWEST_MINOR; minor >= minMinor; minor -= 1) versioned.push(`python3.${minor}`);
  const candidates = platform === 'win32'
    ? [...windowsNames.map((command) => ({ command, args: [] })), { command: 'py', args: ['-3'] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }, ...versioned.map((command) => ({ command, args: [] }))];
  if (platform !== 'win32') {
    const directories = platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', '/Library/Frameworks/Python.framework/Versions/Current/bin']
      : ['/usr/local/bin', '/usr/bin'];
    for (const directory of directories) {
      for (const name of ['python3', ...versioned]) candidates.push({ command: `${directory}/${name}`, args: [] });
    }
  }
  if (includeUv) for (const command of uvManagedPythons(env, platform)) candidates.push({ command, args: [] });
  return candidates;
}

module.exports = { pythonCandidates };
