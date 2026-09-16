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
  // 原生插件源码刷新与工具运行时升级分开，后台每周检查一次。
  try { require('./lib/plugin-updates').schedulePluginUpdate(); } catch (_) {}
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') return passSilent();
  // 非 Git 会话只注入跨工具指导，不探测运行时、刷新索引或写入配置。
  const cwd = repoRoot(hookCwd(input));
  if (!cwd) return additionalContext('SessionStart', CONTEXT);
  let bootstrapStarted = false;
  try { bootstrapStarted = startAutoBootstrap(cwd); } catch (_) {}
  let mcpNotice = '';
  const enabled = isCodeMapEnabled();
  if (enabled) {
    const migration = removeLegacyCrgMcp({ cwd });
    if (!migration.ok) {
      return additionalContext('SessionStart', [migration.diagnostic, CONTEXT].filter(Boolean).join(' '));
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
      mcpNotice = diagnostic
        || 'CodeMap Boost 正在后台安装并配置 code-review-graph。新安装完成后，建议新建 Codex 任务可靠加载 MCP；当前时点未确认工具可用时先回退，后续自然需要时再检查。';
    }
  }
  // 新任务可能已在 hook 写入 AGENTS 前加载规则；恢复/压缩后也需保留入口提醒。
  return additionalContext('SessionStart', [mcpNotice, CONTEXT].filter(Boolean).join(' '));
}

main().catch(() => passSilent());
