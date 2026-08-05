'use strict';

const { additionalContext, passSilent, readStdinJson } = require('./lib/runtime');
const { CONTEXT, isCodeMapEnabled } = require('./lib/codemap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  if (!isCodeMapEnabled()) return passSilent();
  return additionalContext('SubagentStart', CONTEXT);
}

main().catch(() => passSilent());
