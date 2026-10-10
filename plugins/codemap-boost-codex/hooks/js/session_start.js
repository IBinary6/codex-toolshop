'use strict';

const { additionalContext, readStdinJson, hookCwd, passSilent, repoRoot } = require('./lib/runtime');
const {
  CONTEXT,
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  ensureAgentsBlock,
  ensureGitInfoExclude,
  removeLegacyCrgMcp,
} = require('./lib/codemap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') return passSilent();
  // 非 Git 会话只注入跨工具指导，不探测运行时、刷新索引或写入配置。
  const cwd = repoRoot(hookCwd(input));
  if (!cwd) return additionalContext('SessionStart', CONTEXT);
  let mcpNotice = '';
  // 启动时只维护轻量兼容状态；运行时探针、安装和索引由实际图读取触发。
  const migration = removeLegacyCrgMcp({ cwd });
  if (!migration.ok) {
    return additionalContext('SessionStart', [migration.diagnostic, CONTEXT].filter(Boolean).join(' '));
  }
  if (migration.changed) mcpNotice = '已自动移除旧版全局 MCP 覆盖；请新开一个任务加载插件原生 code-review-graph 工具。';
  try { cleanLegacyCrgHooks(); } catch (_) {}
  try { cleanLegacyCrgGitHook(cwd); } catch (_) {}
  try { ensureAgentsBlock(); } catch (_) {}
  try { ensureGitInfoExclude(cwd); } catch (_) {}
  // 新任务可能已在 hook 写入 AGENTS 前加载规则；恢复/压缩后也需保留入口提醒。
  return additionalContext('SessionStart', [mcpNotice, CONTEXT].filter(Boolean).join(' '));
}

main().catch(() => passSilent());
