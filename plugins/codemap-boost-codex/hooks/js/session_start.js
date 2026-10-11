'use strict';

const { additionalContext, readStdinJson, hookCwd, passSilent, repoRoot } = require('./lib/runtime');
const {
  CONTEXT,
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  ensureAgentsBlock,
  ensureGitInfoExclude,
  removeLegacyCrgMcpOnce,
} = require('./lib/codemap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') return passSilent();
  // Outside Git, inject only cross-tool guidance; do not probe runtimes, refresh indexes, or write configuration.
  const cwd = repoRoot(hookCwd(input));
  if (!cwd) return additionalContext('SessionStart', CONTEXT);
  let mcpNotice = '';
  // At startup, maintain lightweight compatibility state only; actual graph reads trigger runtime probes, installation, and indexing.
  const migration = removeLegacyCrgMcpOnce({ cwd });
  if (!migration.ok) {
    return additionalContext('SessionStart', [migration.diagnostic, CONTEXT].filter(Boolean).join(' '));
  }
  if (migration.changed) mcpNotice = 'Removed an old global MCP override automatically. Open a new task to load the native code-review-graph tool.';
  try { cleanLegacyCrgHooks(); } catch (_) {}
  try { cleanLegacyCrgGitHook(cwd); } catch (_) {}
  try { ensureAgentsBlock(); } catch (_) {}
  try { ensureGitInfoExclude(cwd); } catch (_) {}
  // A new task may load rules before the hook writes AGENTS; retain the entry-point reminder after resume or compaction.
  return additionalContext('SessionStart', [mcpNotice, CONTEXT].filter(Boolean).join(' '));
}

main().catch(() => passSilent());
