'use strict';

const { additionalContext, commandExists, readStdinJson, hookCwd, passSilent } = require('./lib/runtime');
const {
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  ensureAgentsBlock,
  readBootstrapFailure,
  ensureGitInfoExclude,
  ensureCrgMcp,
  isCodeMapEnabled,
  refreshCrgSync,
  startAutoBootstrap,
  startCrgBuild,
} = require('./lib/codemap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  const cwd = hookCwd(input);
  let bootstrapStarted = false;
  try { bootstrapStarted = startAutoBootstrap(cwd); } catch (_) {}
  let mcpNotice = '';
  if (isCodeMapEnabled()) {
    if (commandExists('codex') || process.env.CODEMAP_BOOST_ASSUME_CRG !== '1') {
      const mcp = ensureCrgMcp({ cwd });
      if (!mcp.ok) {
        additionalContext('SessionStart', mcp.diagnostic
          || '无法配置 code-review-graph MCP；请修复后新开一个 Codex 任务。');
        return;
      }
      if (mcp.changed) mcpNotice = 'code-review-graph MCP 已修复，请新开一个 Codex 任务使当前会话加载新配置。';
    }
    try { cleanLegacyCrgHooks(); } catch (_) {}
    try { cleanLegacyCrgGitHook(cwd); } catch (_) {}
    try { ensureAgentsBlock(); } catch (_) {}
    try { ensureGitInfoExclude(cwd); } catch (_) {}
    try { refreshCrgSync(cwd); } catch (_) {}
  } else if (process.env.CODEMAP_BOOST_DISABLE_GRAPH !== '1') {
    const diagnostic = readBootstrapFailure();
    if (diagnostic || bootstrapStarted) {
      additionalContext('SessionStart', diagnostic
        || 'CodeMap Boost 正在后台安装并配置 code-review-graph。完成后请新开一个 Codex 任务加载 MCP 工具；当前任务不会动态补载新工具。');
    }
  }
  if (mcpNotice) additionalContext('SessionStart', mcpNotice);
  passSilent();
}

main().catch(() => passSilent());
