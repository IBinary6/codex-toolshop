'use strict';

const { readStdinJson, hookCwd, passSilent } = require('./lib/runtime');
const {
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  ensureAgentsBlock,
  ensureGitignore,
  isCodeMapEnabled,
  startCrgBuild,
} = require('./lib/codemap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  const cwd = hookCwd(input);
  try { cleanLegacyCrgHooks(); } catch (_) {}
  try { cleanLegacyCrgGitHook(cwd); } catch (_) {}
  if (isCodeMapEnabled()) {
    try { ensureAgentsBlock(); } catch (_) {}
    try { ensureGitignore(cwd); } catch (_) {}
    try { startCrgBuild(cwd); } catch (_) {}
  }
  passSilent();
}

main().catch(() => passSilent());
