'use strict';

const { readStdinJson, passSilent } = require('./lib/runtime');

async function main() {
  await readStdinJson({ timeoutMs: 2000 });
  // Edits and worktree creation neither start the graph process nor clear verified provenance.
  // Source, runtime, and database fingerprints before an actual read determine whether refresh is needed.
  return passSilent();
}

if (require.main === module) main().catch(() => passSilent());

module.exports = { main };
