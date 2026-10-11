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

/** Fallback: run the hook in a child process with the same timeout; hook failures never block the main flow. */
function runInChild(script, env, timeout) {
  let input = Buffer.alloc(0);
  try { input = fs.readFileSync(0); } catch (_) {}
  spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    input,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: process.platform === 'win32',
    timeout,
  });
}

function main() {
  /** Read Codex hook input and run the corresponding local script. */
  const hook = process.argv[2];
  const relative = HOOKS[hook];
  if (!relative) return;
  const root = pluginRoot();
  const script = path.join(root, relative);
  const env = { PLUGIN_ROOT: root };
  const timeoutMs = HOOK_TIMEOUT_MS[hook];
  if (process.env.TOOLSHOP_HOOKS_CHILD_PROCESS === '1') {
    runInChild(script, env, timeoutMs);
    return;
  }
  // A hook that never finishes is cut off before the host's own timeout, without failing the task.
  setTimeout(() => process.exit(0), timeoutMs).unref();
  runInProcess(script, { label: 'local-knowledge-codex', env });
}

if (require.main === module) main();

module.exports = { HOOK_TIMEOUT_MS };
