'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pluginDataDir } = require('../hooks/js/lib/runtime');

const LABEL = 'codemap-boost-codex';
const HOOKS = {
  session_start: path.join('hooks', 'js', 'session_start.js'),
  pre_graph_tool: path.join('hooks', 'js', 'pre_graph_tool.js'),
  pre_code_search: path.join('hooks', 'js', 'pre_code_search.js'),
  user_prompt_submit: path.join('hooks', 'js', 'user_prompt_submit.js'),
  subagent_start: path.join('hooks', 'js', 'subagent_start.js'),
};
// The graph barrier must fail closed and never emit partial output, so it always runs in a supervised child process.
const BARRIER = 'pre_graph_tool';

function pluginRoot() {
  const fromEnv = process.env.PLUGIN_ROOT;
  return fromEnv ? path.resolve(fromEnv) : path.resolve(__dirname, '..');
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

/** Run the hook in a child process; the graph barrier captures stdout so a failure never leaks partial output. */
function runInChild(hookName, script, env) {
  const child = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    input: readStdin(),
    stdio: ['pipe', hookName === BARRIER ? 'pipe' : 'inherit', 'inherit'],
    windowsHide: process.platform === 'win32',
  });

  if (child.error) {
    process.stderr.write(`[${LABEL}] hook failed to start: ${child.error.message}\n`);
  }
  if (hookName === BARRIER) {
    if (child.error || child.status !== 0) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'CodeMap refresh barrier could not complete. Use source inspection or repair the plugin before retrying.',
      } }));
    } else if (child.stdout) process.stdout.write(child.stdout);
  }
  process.exit(0);
}

function main() {
  const hookName = process.argv[2];
  const rel = HOOKS[hookName];
  if (!rel) {
    process.stderr.write(`[${LABEL}] unknown hook: ${hookName || '<missing>'}\n`);
    process.exit(0);
  }

  const root = pluginRoot();
  const script = path.join(root, rel);
  const env = { PLUGIN_ROOT: root, PLUGIN_DATA: pluginDataDir({ pluginRoot: root }) };
  if (hookName === BARRIER || process.env.TOOLSHOP_HOOKS_CHILD_PROCESS === '1') runInChild(hookName, script, env);
  else runInProcess(script, { label: LABEL, env });
}

main();
