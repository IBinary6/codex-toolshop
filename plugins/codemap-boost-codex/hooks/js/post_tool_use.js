'use strict';

const { readStdinJson, hookCwd, passSilent } = require('./lib/runtime');
const { startCrgUpdate } = require('./lib/codemap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  try { startCrgUpdate(hookCwd(input)); } catch (_) {}
  passSilent();
}

main().catch(() => passSilent());
