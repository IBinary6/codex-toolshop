'use strict';

const { readStdinJson, hookCwd, passSilent } = require('./lib/runtime');
const {
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  ensureAgentsBlock,
  ensureGitignore,
  registerCrgMcp,
  startCrgBuild,
} = require('./lib/codemap');
const { spawnPrewarm } = require('./lib/bootstrap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  const cwd = hookCwd(input);
  try { cleanLegacyCrgHooks(); } catch (_) {}
  try { cleanLegacyCrgGitHook(cwd); } catch (_) {}
  try { ensureAgentsBlock(); } catch (_) {}
  try { ensureGitignore(cwd); } catch (_) {}
  if (process.env.CODEMAP_BOOST_DISABLE_BOOTSTRAP !== '1') {
    try { spawnPrewarm(); } catch (_) {}
    try { registerCrgMcp(); } catch (_) {}
  }
  try { startCrgBuild(cwd); } catch (_) {}
  passSilent();
}

main().catch(() => passSilent());
