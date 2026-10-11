'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL = 'conversation-namer-codex';
const HOOKS = {
  session_start: path.join('hooks', 'js', 'session_start.js'),
  user_prompt_submit: path.join('hooks', 'js', 'user_prompt_submit.js'),
  desktop_delivery: path.join('hooks', 'js', 'desktop_delivery.js'),
};

/**
 * Resolve the plugin root so the hook loads the same implementation and policy.
 *
 * @returns {string} Absolute plugin root.
 * @example
 * const root = pluginRoot();
 */
function pluginRoot() {
  return process.env.PLUGIN_ROOT
    ? path.resolve(process.env.PLUGIN_ROOT)
    : path.resolve(__dirname, '..');
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

/** Fallback model (TOOLSHOP_HOOKS_CHILD_PROCESS=1): forward the hook input to a child process; fail open. */
function runInChild(script, env) {
  let stdin = Buffer.alloc(0);
  try {
    stdin = fs.readFileSync(0);
  } catch (error) {
    process.stderr.write(`[${LABEL}] hook setup failed: ${error.message}\n`);
    return;
  }
  const child = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    input: stdin,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: process.platform === 'win32',
  });
  if (child.error) {
    process.stderr.write(`[${LABEL}] hook failed to start: ${child.error.message}\n`);
  } else if (child.status !== 0) {
    process.stderr.write(`[${LABEL}] hook exited with status ${child.status}\n`);
  }
}

/**
 * Run the requested hook; fail open so user requests are not blocked.
 *
 * @returns {void}
 * @example
 * main();
 */
function main() {
  const hookName = process.argv[2];
  const relativePath = HOOKS[hookName];
  if (!relativePath) {
    process.stderr.write(`[${LABEL}] unknown hook: ${hookName || '<missing>'}\n`);
    return;
  }

  const root = pluginRoot();
  const script = path.join(root, relativePath);
  const env = { PLUGIN_ROOT: root };
  if (process.env.TOOLSHOP_HOOKS_CHILD_PROCESS === '1') runInChild(script, env);
  else runInProcess(script, { label: LABEL, env });
}

main();
