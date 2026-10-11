'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL = 'agent-dispatch-codex';
const HOOKS = {
  session_start: path.join('hooks', 'js', 'session_start.js'),
  user_prompt_submit: path.join('hooks', 'js', 'user_prompt_submit.js'),
  pre_tool_use: path.join('hooks', 'js', 'pre_tool_use.js'),
  subagent_start: path.join('hooks', 'js', 'subagent_start.js'),
};

function pluginRoot() {
  return process.env.PLUGIN_ROOT
    ? path.resolve(process.env.PLUGIN_ROOT)
    : path.resolve(__dirname, '..');
}

function pluginDataDir() {
  if (process.env.PLUGIN_DATA) return path.resolve(process.env.PLUGIN_DATA);
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'plugins', 'data', 'agent-dispatch-codex');
}

/**
 * Run `script` as this process's entry point, as `node script` would, instead of starting a second Node
 * process (about 40 ms per hook). Hooks that guard on `require.main === module` still run.
 * A failing hook must never fail the task: report on stderr and exit 0, as this runner always has.
 * The same block is used by the other fail-open hook runners in this marketplace;
 * scripts/check-runner-sync.cjs fails CI if the copies drift apart.
 * @example runInProcess('/plugin/hooks/js/session_start.js', { label: 'my-plugin', env: { PLUGIN_ROOT: '/plugin' } })
 */
function runInProcess(script, { label, env }) {
  Object.assign(process.env, env);
  process.argv[1] = script;
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[${label}] hook failed: ${error && error.message ? error.message : error}\n`);
    process.exit(0);
  });
  process.once('exit', (code) => {
    if (code) process.stderr.write(`[${label}] hook exited with status ${code}\n`);
    process.exitCode = 0;
  });
  require('module')._load(script, null, true);
}

/** Fallback: run the hook in a child process with the same environment. */
function runInChild(script, env) {
  let stdin = Buffer.alloc(0);
  try { stdin = fs.readFileSync(0); } catch (_) {}
  const child = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    input: stdin,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: process.platform === 'win32',
  });
  if (child.error) {
    process.stderr.write(`[${LABEL}] hook failed to start: ${child.error.message}\n`);
  }
}

function main() {
  const hook = process.argv[2];
  const relative = HOOKS[hook];
  if (!relative) {
    process.stderr.write(`[${LABEL}] unknown hook: ${hook || '<missing>'}\n`);
    return;
  }
  const root = pluginRoot();
  const data = pluginDataDir();
  try { fs.mkdirSync(data, { recursive: true }); } catch (_) {}
  const script = path.join(root, relative);
  const env = { PLUGIN_ROOT: root, PLUGIN_DATA: data };
  if (process.env.TOOLSHOP_HOOKS_CHILD_PROCESS === '1') runInChild(script, env);
  else runInProcess(script, { label: LABEL, env });
}

main();
