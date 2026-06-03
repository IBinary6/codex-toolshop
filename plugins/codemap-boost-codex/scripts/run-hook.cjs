'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = {
  session_start: path.join('hooks', 'js', 'session_start.js'),
  post_tool_use: path.join('hooks', 'js', 'post_tool_use.js'),
  pre_bash: path.join('hooks', 'js', 'pre_bash.js'),
  user_prompt_submit: path.join('hooks', 'js', 'user_prompt_submit.js'),
  subagent_start: path.join('hooks', 'js', 'subagent_start.js'),
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
  const safeName = path.basename(root).replace(/[^A-Za-z0-9._-]/g, '_') || 'codemap-boost-codex';
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
    process.stderr.write(`[codemap-boost-codex] unknown hook: ${hookName || '<missing>'}\n`);
    process.exit(0);
  }

  const root = pluginRoot();
  const target = path.join(root, rel);
  const dataDir = pluginDataDir(root);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (_) {}

  const child = spawnSync(process.execPath, [target], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PLUGIN_ROOT: root,
      PLUGIN_DATA: dataDir,
    },
    input: readStdin(),
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: process.platform === 'win32',
  });

  if (child.error) {
    process.stderr.write(`[codemap-boost-codex] hook failed to start: ${child.error.message}\n`);
  }
  process.exit(0);
}

main();
