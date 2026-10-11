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

main();
