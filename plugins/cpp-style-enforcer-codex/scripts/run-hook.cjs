'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = {
  session_start: path.join('hooks', 'js', 'session_start.js'),
  post_edit: path.join('hooks', 'js', 'post_edit.js'),
  stop_check: path.join('hooks', 'js', 'stop_check.js'),
  pre_commit: path.join('hooks', 'js', 'pre_commit.js'),
};

function pluginRoot() {
  const fromEnv = process.env.PLUGIN_ROOT;
  return fromEnv ? path.resolve(fromEnv) : path.resolve(__dirname, '..');
}

function pluginDataDir(root) {
  const fromEnv = process.env.PLUGIN_DATA;
  if (fromEnv) return path.resolve(fromEnv);
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  const safeName = path.basename(root).replace(/[^A-Za-z0-9._-]/g, '_') || 'cpp-style-enforcer-codex';
  return path.join(codexHome, 'plugins', 'data', safeName);
}

function readStdin() {
  try {
    return fs.readFileSync(0);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function main() {
  const hookName = process.argv[2];
  const rel = HOOKS[hookName];
  if (!rel) {
    process.stderr.write(`[cpp-style-enforcer-codex] unknown hook: ${hookName || '<missing>'}\n`);
    process.exit(0);
  }

  const root = pluginRoot();
  const target = path.join(root, rel);
  const dataDir = pluginDataDir(root);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (_) {}

  const env = {
    ...process.env,
    PLUGIN_ROOT: root,
    PLUGIN_DATA: dataDir,
  };

  const child = spawnSync(process.execPath, [target], {
    cwd: process.cwd(),
    env,
    input: readStdin(),
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: process.platform === 'win32',
  });

  if (child.error) {
    process.stderr.write(`[cpp-style-enforcer-codex] hook failed to start: ${child.error.message}\n`);
    process.exit(0);
  }
  process.exit(typeof child.status === 'number' ? child.status : 0);
}

main();
