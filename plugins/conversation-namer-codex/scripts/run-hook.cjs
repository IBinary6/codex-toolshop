'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = {
  session_start: path.join('hooks', 'js', 'session_start.js'),
  user_prompt_submit: path.join('hooks', 'js', 'user_prompt_submit.js'),
  desktop_delivery: path.join('hooks', 'js', 'desktop_delivery.js'),
};

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

module.exports = { shouldSkipHook };
