'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = {
  session_start: path.join('hooks', 'js', 'session_start.js'),
  user_prompt_submit: path.join('hooks', 'js', 'user_prompt_submit.js'),
  desktop_delivery: path.join('hooks', 'js', 'desktop_delivery.js'),
};
// desktop_delivery inspects stdin to decide whether it has anything to do, so it cannot share stdin with an
// in-process hook; it is skipped when idle and otherwise runs in a child process.
const IN_PROCESS = new Set(['session_start', 'user_prompt_submit']);

/**
 * Resolve the plugin root so the hook subprocess loads the same implementation and policy.
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
 * Decide whether a PostToolUse desktop_delivery run is provably a no-op, so the per-tool-call
 * hook can skip starting a second Node process. Delivery acts only on a `ready` title, so a missing
 * or non-ready state (pending, started, done) changes nothing. Any doubt returns false and runs the hook.
 *
 * @param {string} hookName Hook name from argv.
 * @param {Buffer} stdin Raw hook input.
 * @param {object} [env] Environment used to locate the state directory.
 * @returns {boolean} True when the hook has nothing to do.
 * @example
 * shouldSkipHook('desktop_delivery', Buffer.from('{"hook_event_name":"PostToolUse"}'));
 */
function shouldSkipHook(hookName, stdin, env = process.env) {
  if (hookName !== 'desktop_delivery') return false;
  try {
    const input = JSON.parse(stdin.toString('utf8'));
    if (!input || input.hook_event_name !== 'PostToolUse') return false;
    const { validatedSessionId } = require('../hooks/js/lib/guidance');
    const { readState } = require('../hooks/js/lib/state');
    const sessionId = validatedSessionId(input);
    if (!sessionId) return true;
    return readState(sessionId, env)?.status !== 'ready';
  } catch (_) {
    return false;
  }
}

/**
 * Run `script` as this process's entry point, as `node script` would, instead of starting a second Node
 * process (about 40 ms per hook). Hooks that guard on `require.main === module` still run.
 * A failing hook must never fail the task: report on stderr and exit 0, as this runner always has.
 * Returns false when in-process mode is unavailable or switched off with TOOLSHOP_HOOKS_CHILD_PROCESS=1.
 * The same block is used by the other hook runners in this marketplace; keep them in sync.
 * @example runInProcess('/plugin/hooks/js/session_start.js', { label: 'my-plugin', env: { PLUGIN_ROOT: '/plugin' } })
 */
function runInProcess(script, { label, env = {}, timeoutMs = 0 } = {}) {
  const Module = require('module');
  if (process.env.TOOLSHOP_HOOKS_CHILD_PROCESS === '1' || typeof Module._load !== 'function') return false;
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
  if (timeoutMs > 0) setTimeout(() => process.exit(0), timeoutMs).unref();
  Module._load(script, null, true);
  return true;
}

/**
 * Forward JSONL hook input; fail open if the subprocess fails so user requests are not blocked.
 *
 * @returns {void}
 * @example
 * main();
 */
function main() {
  const hookName = process.argv[2];
  const relativePath = HOOKS[hookName];
  if (!relativePath) {
    process.stderr.write(`[conversation-namer-codex] unknown hook: ${hookName || '<missing>'}\n`);
    return;
  }

  const root = pluginRoot();
  if (IN_PROCESS.has(hookName)
      && runInProcess(path.join(root, relativePath), { label: 'conversation-namer-codex', env: { PLUGIN_ROOT: root } })) return;

  let stdin = Buffer.alloc(0);
  try {
    stdin = fs.readFileSync(0);
  } catch (error) {
    process.stderr.write(`[conversation-namer-codex] hook setup failed: ${error.message}\n`);
    return;
  }

  if (shouldSkipHook(hookName, stdin, { ...process.env, PLUGIN_ROOT: root })) return;

  const child = spawnSync(process.execPath, [path.join(root, relativePath)], {
    cwd: process.cwd(),
    env: { ...process.env, PLUGIN_ROOT: root },
    input: stdin,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: process.platform === 'win32',
  });
  if (child.error) {
    process.stderr.write(`[conversation-namer-codex] hook failed to start: ${child.error.message}\n`);
  } else if (child.status !== 0) {
    process.stderr.write(`[conversation-namer-codex] hook exited with status ${child.status}\n`);
  }
}

if (require.main === module) main();

module.exports = { shouldSkipHook, runInProcess };
