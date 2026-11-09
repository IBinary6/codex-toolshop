'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { diag, hookFailure } = require('../hooks/js/lib/protocol');

const HOOKS = {
  session_start: path.join('hooks', 'js', 'session_start.js'),
  post_edit: path.join('hooks', 'js', 'post_edit.js'),
  stop_check: path.join('hooks', 'js', 'stop_check.js'),
  pre_commit: path.join('hooks', 'js', 'pre_commit.js'),
};
const EVENTS = {
  session_start: 'SessionStart', post_edit: 'PostToolUse', stop_check: 'Stop', pre_commit: 'PreToolUse',
};

function pluginRoot() {
  const fromEnv = process.env.PLUGIN_ROOT;
  return fromEnv ? path.resolve(fromEnv) : path.resolve(__dirname, '..');
}

function pluginDataDir() {
  const fromEnv = process.env.PLUGIN_DATA;
  if (fromEnv) return path.resolve(fromEnv);
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  // Fixed name: inside the Codex cache the plugin root's own name is the version folder, which changes on upgrade.
  return path.join(codexHome, 'plugins', 'data', 'cpp-style-enforcer-codex');
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
 */
function runInProcess(script, env, event) {
  Object.assign(process.env, env);
  let stdout = '';
  const fail = (error) => {
    stdout = '';
    hookFailure(event, error);
  };
  process.stdout.write = (chunk, encoding, callback) => {
    stdout = (stdout + String(chunk)).slice(0, 65536);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  process.stderr.write = (chunk, encoding, callback) => {
    diag(chunk);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  process.once('uncaughtException', fail);
  process.once('unhandledRejection', fail);
  process.once('exit', (code) => {
    if (code !== 0) return fail(`Hook exited with status ${code}`);
    try { forwardOutput(stdout); } catch (error) { fail(error); }
  });
  process.argv[1] = script;
  try { require('module')._load(script, null, true); }
  catch (error) { fail(error); }
}

function forwardOutput(output) {
  const json = String(output || '').trim();
  if (!json) return;
  JSON.parse(json);
  fs.writeSync(1, json);
}

/** Fallback: collect child diagnostics locally and keep the same host protocol. */
function runInChild(script, env, event) {
  const child = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: process.platform === 'win32',
  });

  if (child.stderr?.length) diag(child.stderr, env.PLUGIN_DATA);
  if (child.error || child.status !== 0) {
    return hookFailure(event, child.error || child.stderr?.toString() || `Hook exited with status ${child.status}`);
  }
  forwardOutput(child.stdout);
}

function main() {
  const hookName = process.argv[2];
  const rel = Object.hasOwn(HOOKS, hookName) ? HOOKS[hookName] : null;
  const root = pluginRoot();
  const dataDir = pluginDataDir();
  process.env.PLUGIN_DATA = dataDir;
  if (!rel) return hookFailure(undefined, `Unknown hook: ${hookName || '<missing>'}`);
  const script = path.join(root, rel);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (_) {}

  const env = { PLUGIN_ROOT: root, PLUGIN_DATA: dataDir };
  // session_start never reads its input. Consume it first, as this runner always did, so the host's write to
  // the pipe cannot fail with EPIPE because the process already exited.
  if (hookName === 'session_start') readStdin();
  try {
    if (process.env.TOOLSHOP_HOOKS_CHILD_PROCESS === '1') runInChild(script, env, EVENTS[hookName]);
    else runInProcess(script, env, EVENTS[hookName]);
  } catch (error) {
    hookFailure(EVENTS[hookName], error);
  }
}

main();
