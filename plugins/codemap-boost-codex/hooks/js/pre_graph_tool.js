'use strict';

const { hookCwd, passSilent, readStdinJson, repoRoot } = require('./lib/runtime');
const { canUseCrg, refreshCrgSync, startAutoBootstrap } = require('./lib/codemap');

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

async function main() {
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') return passSilent();
  const input = await readStdinJson({ timeoutMs: 2000 });
  const requestedRoot = input && input.tool_input && input.tool_input.repo_root;
  const cwd = typeof requestedRoot === 'string' && requestedRoot ? requestedRoot : hookCwd(input);
  if (!repoRoot(cwd)) return passSilent();
  if (!canUseCrg()) {
    try { startAutoBootstrap(cwd); } catch (_) {}
    return deny('CodeMap graph tool blocked because code-review-graph is not ready. Wait for bootstrap or run codemap-boost-setup, then retry.');
  }
  if (!refreshCrgSync(cwd)) {
    return deny('CodeMap graph tool blocked because the required build/update did not complete. Retry after the active refresh finishes.');
  }
  return passSilent();
}

main().catch(() => deny('CodeMap graph tool blocked because the refresh barrier failed.'));
