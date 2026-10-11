'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = {
  session_start: path.join('hooks', 'js', 'local_knowledge_session.js'),
  post_tool_use: path.join('hooks', 'js', 'local_knowledge_check.js'),
  user_prompt_submit: path.join('hooks', 'js', 'local_knowledge_prompt.js'),
};
const HOOK_TIMEOUT_MS = Object.freeze({
  session_start: 9000,
  post_tool_use: 4500,
  user_prompt_submit: 4500,
});

function pluginRoot() {
  /** Return the current plugin root. */
  return path.resolve(process.env.PLUGIN_ROOT || path.join(__dirname, '..'));
}

function main() {
  /** Read Codex hook input and run the corresponding local script. */
  const relative = HOOKS[process.argv[2]];
  if (!relative) return;
  let input = Buffer.alloc(0);
  try { input = fs.readFileSync(0); } catch (_) {}
  const root = pluginRoot();
  const child = spawnSync(process.execPath, [path.join(root, relative)], {
    cwd: process.cwd(),
    env: { ...process.env, PLUGIN_ROOT: root },
    input,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: process.platform === 'win32',
    timeout: HOOK_TIMEOUT_MS[process.argv[2]],
  });
  if (child.error) {
    // Hook failures must not block the main flow; diagnose explicitly with the CLI.
    process.exitCode = 0;
  }
}

if (require.main === module) main();

module.exports = { HOOK_TIMEOUT_MS };
