'use strict';

const { readStdinJson, hookCwd, passSilent } = require('./lib/runtime');
const {
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  cleanCrgMcpConfig,
  ensureAgentsBlock,
  ensureGitignore,
  hasCodeMapMarker,
  isCodeMapEnabled,
  removeAgentsBlock,
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
  } else {
    try { removeAgentsBlock(); } catch (_) {}
    if (!hasCodeMapMarker()) {
      try { cleanCrgMcpConfig(); } catch (_) {}
    }
  }
  passSilent();
}

main().catch(() => passSilent());
