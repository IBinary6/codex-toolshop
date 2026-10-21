'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT_SCOPED_CRG_TOOLS } = require('../hooks/js/pre_graph_tool');

/** Keep the same freshness gate when the host does not run an inner MCP hook.
 * An explicit absolute project root is required: the server cwd is plugin data.
 * Registry tools and discovery remain lightweight and do not prepare a graph.
 */
async function prepareToolCall(params, options = {}) {
  if (!ROOT_SCOPED_CRG_TOOLS.has(params?.name)) return params;
  const root = params.arguments?.repo_root;
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('CodeMap requires an absolute repo_root for project tools.');
  }
  const args = await new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) return reject(new Error('CodeMap graph preparation cancelled.'));
    const child = (options.spawn || spawn)(process.execPath, [__filename, JSON.stringify({
      root, pluginDataDir: options.pluginDataDir, runtimeDir: options.runtimeDir,
      version: options.version, expectedVersion: options.expectedVersion,
    })], {
      cwd: options.pluginDataDir || process.cwd(), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { ...process.env, ...(options.env || {}) },
    });
    let output = '';
    // Host shutdown owns this child tree. Request cancellation alone leaves the
    // shared graph refresh running, but EOF must not retain a detached worker.
    const abort = () => {
      Promise.resolve((options.killTree || require('./lazy-mcp.cjs').killProcessTree)(child))
        .then(() => reject(new Error('CodeMap graph preparation cancelled.')), reject);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', abort);
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.resume();
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code) => {
      cleanup();
      try {
        if (signal?.aborted) throw new Error('CodeMap graph preparation cancelled.');
        const result = JSON.parse(output);
        if (code !== 0 || !result.ok) throw new Error(result.diagnostic || 'CodeMap graph preparation failed.');
        resolve(result.root);
      } catch (error) { reject(error); }
    });
  });
  return { ...params, arguments: { ...params.arguments, repo_root: args } };
}

if (require.main === module) {
  try {
    const options = JSON.parse(process.argv[2]);
    const { repoRoot } = require('../hooks/js/lib/runtime');
    const { prepareCrgForRead } = require('../hooks/js/lib/codemap');
    const root = repoRoot(options.root);
    if (!root) throw new Error('CodeMap target is not a Git worktree.');
    const diagnostics = [];
    if (!prepareCrgForRead(root, { ...options, diagnostics })) {
      throw new Error(diagnostics.at(-1)?.message || 'CodeMap graph preparation failed.');
    }
    process.stdout.write(JSON.stringify({ ok: true, root }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, diagnostic: error.message }));
    process.exitCode = 1;
  }
}

module.exports = { prepareToolCall };
