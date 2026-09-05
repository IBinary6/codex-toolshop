'use strict';

const { additionalContext, hookCwd, passSilent, readStdinJson, repoRoot } = require('./lib/runtime');
const { CONTEXT, isCodeMapEnabled } = require('./lib/codemap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  if (!repoRoot(hookCwd(input))) return passSilent();
  if (!isCodeMapEnabled()) return passSilent();
  return additionalContext('SubagentStart', CONTEXT);
}

main().catch(() => passSilent());
