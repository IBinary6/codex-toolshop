'use strict';

const { additionalContext, passSilent, readStdinJson } = require('./lib/runtime');
const { CONTEXT } = require('./lib/codemap');

async function main() {
  await readStdinJson({ timeoutMs: 2000 });
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') return passSilent();
  return additionalContext('SubagentStart', CONTEXT);
}

main().catch(() => passSilent());
