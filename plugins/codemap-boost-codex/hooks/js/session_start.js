'use strict';

const { additionalContext, readStdinJson, hookCwd, passSilent, repoRoot } = require('./lib/runtime');
const {
  CONTEXT,
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  ensureAgentsBlock,
  readBootstrapFailure,
  ensureGitInfoExclude,
  isCodeMapEnabled,
  refreshCrgSync,
  removeLegacyCrgMcp,
  startAutoBootstrap,
} = require('./lib/codemap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  // Git 自身解析父目录与 worktree 的 .git 文件，非工作区不探测运行时或写入配置。
  const cwd = repoRoot(hookCwd(input));
  if (!cwd) return passSilent();
  let bootstrapStarted = false;
  try { bootstrapStarted = startAutoBootstrap(cwd); } catch (_) {}
  let mcpNotice = '';
  if (isCodeMapEnabled()) {
    const migration = removeLegacyCrgMcp({ cwd });
    if (!migration.ok) {
      additionalContext('SessionStart', migration.diagnostic);
      return;
    }
    if (migration.changed) mcpNotice = '已自动移除旧版全局 MCP 覆盖；请新开一个任务加载插件原生 code-review-graph 工具。';
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
  // 新任务可能已在 hook 写入 AGENTS 前加载规则；恢复/压缩后也需保留入口提醒。
  if (isCodeMapEnabled()) additionalContext('SessionStart', [mcpNotice, CONTEXT].filter(Boolean).join(' '));
  passSilent();
}

main().catch(() => passSilent());
