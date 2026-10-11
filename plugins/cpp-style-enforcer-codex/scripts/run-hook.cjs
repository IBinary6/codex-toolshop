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

/**
 * Run `script` as this process's entry point, as `node script` would, instead of starting a second Node
 * process (about 40 ms per hook). Hooks that guard on `require.main === module` still run.
 * Unlike the other hook runners in this marketplace the hook's own exit status is kept, because a
 * hook that exits with 2 blocks the action it was checking.
 * @example runInProcess('/plugin/hooks/js/post_edit.js', { PLUGIN_ROOT: '/plugin' })
 */
function runInProcess(script, env) {
  Object.assign(process.env, env);
  process.argv[1] = script;
  require('module')._load(script, null, true);
}

/** Fallback: run the hook in a child process and pass its exit status through. */
function runInChild(script, env) {
  const child = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
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

function main() {
  const hookName = process.argv[2];
  const rel = HOOKS[hookName];
  if (!rel) {
    process.stderr.write(`[cpp-style-enforcer-codex] unknown hook: ${hookName || '<missing>'}\n`);
    process.exit(0);
  }

  const root = pluginRoot();
  const script = path.join(root, rel);
  const dataDir = pluginDataDir(root);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (_) {}

  const env = { PLUGIN_ROOT: root, PLUGIN_DATA: dataDir };
  // session_start never reads its input. Consume it first, as this runner always did, so the host's write to
  // the pipe cannot fail with EPIPE because the process already exited.
  if (hookName === 'session_start') readStdin();
  if (process.env.TOOLSHOP_HOOKS_CHILD_PROCESS === '1') runInChild(script, env);
  else runInProcess(script, env);
}

main();
