'use strict';

const { readStdinJson, hookCwd, passSilent } = require('./lib/runtime');
const {
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  ensureAgentsBlock,
  ensureGitInfoExclude,
  isCodeMapEnabled,
  startAutoBootstrap,
  startCrgBuild,
} = require('./lib/codemap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  const cwd = hookCwd(input);
  try { startAutoBootstrap(cwd); } catch (_) {}
  if (isCodeMapEnabled()) {
    try { cleanLegacyCrgHooks(); } catch (_) {}
    try { cleanLegacyCrgGitHook(cwd); } catch (_) {}
    try { ensureAgentsBlock(); } catch (_) {}
    try { ensureGitInfoExclude(cwd); } catch (_) {}
    try { startCrgBuild(cwd); } catch (_) {}
  }
  passSilent();
}

main().catch(() => passSilent());
