'use strict';

const { additionalContext, hookCwd, passSilent, readStdinJson, repoRoot } = require('./lib/runtime');
const { isCodeMapEnabled } = require('./lib/codemap');
const { SEARCH_CONTEXT, looksLikeCodeSearch, claimSearchReminder } = require('./lib/search_reminder');

/** Add one short reminder before a search without rewriting commands or refreshing the graph.@example main() */
async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  // Return quietly for ordinary commands so each shell call does not probe the graph runtime.
  if (!looksLikeCodeSearch(input) || !repoRoot(hookCwd(input))) return passSilent();
  if (!isCodeMapEnabled()) return passSilent();
  if (!claimSearchReminder(input)) return passSilent();
  return additionalContext('PreToolUse', SEARCH_CONTEXT);
}

main().catch(() => passSilent());
