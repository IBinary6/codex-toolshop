'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';

function codexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function pluginDataDir() {
  if (process.env.PLUGIN_DATA) return path.resolve(process.env.PLUGIN_DATA);
  return path.join(codexHome(), 'plugins', 'data', 'codemap-boost-codex');
}

function hookCwd(input) {
  return (input && typeof input.cwd === 'string' && input.cwd)
    ? path.resolve(input.cwd)
    : process.cwd();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function readStdinJson(options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const maxSize = options.maxSize || 1024 * 1024;
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        done(data.trim() ? JSON.parse(data) : {});
      } catch (_) {
        done({});
      }
    }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (data.length < maxSize) data += chunk;
    });
    process.stdin.on('end', () => {
      try {
        done(data.trim() ? JSON.parse(data) : {});
      } catch (_) {
        done({});
      }
    });
    process.stdin.on('error', () => done({}));
  });
}

function passSilent() {
  process.exit(0);
}

function additionalContext(hookEventName, text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: text,
    },
  }));
  process.exit(0);
}

function commandExists(cmd) {
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1' && (cmd === 'code-review-graph' || cmd === 'graphify')) return false;
  if (process.env.CODEMAP_BOOST_ASSUME_CRG === '1' && cmd === 'code-review-graph') return true;
  if (!/^[A-Za-z0-9_.-]+$/.test(cmd)) return false;
  try {
    const probe = isWindows ? 'where' : 'which';
    const result = spawnSync(probe, [cmd], {
      stdio: 'ignore',
      windowsHide: isWindows,
      timeout: 10000,
    });
    return !result.error && result.status === 0;
  } catch (_) {
    return false;
  }
}

function repoRoot(cwd) {
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: isWindows,
      timeout: 5000,
    });
    if (!result.error && result.status === 0 && result.stdout.trim()) {
      return path.resolve(result.stdout.trim());
    }
  } catch (_) {}
  return null;
}

function isGitRepo(cwd) {
  return !!repoRoot(cwd);
}

function markerPath(name) {
  return path.join(pluginDataDir(), name);
}

function markerExists(name) {
  try {
    return fs.existsSync(markerPath(name));
  } catch (_) {
    return false;
  }
}

function writeMarker(name) {
  try {
    const target = markerPath(name);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, '1');
  } catch (_) {}
}

function spawnDetached(cmd, args, options = {}) {
  try {
    const child = spawn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      detached: true,
      env: options.env || process.env,
      stdio: options.stdio || 'ignore',
      windowsHide: isWindows,
    });
    child.unref();
    return child;
  } catch (_) {
    return null;
  }
}

module.exports = {
  isWindows,
  codexHome,
  pluginDataDir,
  hookCwd,
  ensureDir,
  readStdinJson,
  passSilent,
  additionalContext,
  commandExists,
  repoRoot,
  isGitRepo,
  markerPath,
  markerExists,
  writeMarker,
  spawnDetached,
};
