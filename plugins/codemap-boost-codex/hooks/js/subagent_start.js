'use strict';

const { additionalContext, hookCwd, passSilent, readStdinJson } = require('./lib/runtime');
const { CONTEXT, isCodeMapEnabled, refreshCrgSync } = require('./lib/codemap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  if (!isCodeMapEnabled()) return passSilent();
  const refreshed = refreshCrgSync(hookCwd(input));
  const status = refreshed
    ? 'CodeMap graph refresh completed for the current project.'
    : 'CodeMap graph refresh did not complete; do not rely on stale graph results.';
  return additionalContext('SubagentStart', `${status} ${CONTEXT}`);
}

main().catch(() => passSilent());
