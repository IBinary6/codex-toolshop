'use strict';

const { hookCwd, passSilent, readStdinJson, repoRoot } = require('./lib/runtime');
const { canUseCrg, refreshCrgSync, startAutoBootstrap } = require('./lib/codemap');

const ROOT_SCOPED_CRG_TOOLS = new Set([
  'build_or_update_graph_tool',
  'run_postprocess_tool',
  'get_minimal_context_tool',
  'get_impact_radius_tool',
  'query_graph_tool',
  'get_review_context_tool',
  'semantic_search_nodes_tool',
  'embed_graph_tool',
  'list_graph_stats_tool',
  'get_docs_section_tool',
  'find_large_functions_tool',
  'list_flows_tool',
  'get_flow_tool',
  'get_affected_flows_tool',
  'list_communities_tool',
  'get_community_tool',
  'get_architecture_overview_tool',
  'detect_changes_tool',
  'refactor_tool',
  'apply_refactor_tool',
  'generate_wiki_tool',
  'get_wiki_page_tool',
  'get_hub_nodes_tool',
  'get_bridge_nodes_tool',
  'get_knowledge_gaps_tool',
  'get_surprising_connections_tool',
  'get_suggested_questions_tool',
  'traverse_graph_tool',
]);

/**
 * 允许工具调用并用当前仓库根目录补全 CRG 的 repo_root。
 * @example allowWithRepoRoot({ query: 'auth' }, '/workspace/repo')
 */
function allowWithRepoRoot(toolInput, root) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...toolInput, repo_root: root },
    },
  }));
  process.exit(0);
}

/**
 * 判断当前调用是否是接受 repo_root 的 Code Review Graph 工具。
 * @example shouldInjectRepoRoot('mcp__code_review_graph__query_graph_tool')
 */
function shouldInjectRepoRoot(toolName) {
  const match = /^mcp__(?:code_review_graph|code-review-graph)__(.+)$/.exec(String(toolName || ''));
  return !!match && ROOT_SCOPED_CRG_TOOLS.has(match[1]);
}

/**
 * 为未指定仓库的 CRG 工具生成完整输入；不适用时返回 null。
 * @example repoRootUpdate('mcp__code_review_graph__query_graph_tool', { target: 'main' }, '/workspace/repo')
 */
function repoRootUpdate(toolName, toolInput, root) {
  if (!shouldInjectRepoRoot(toolName) || toolInput.repo_root) return null;
  return { ...toolInput, repo_root: root };
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

async function main() {
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') return passSilent();
  const input = await readStdinJson({ timeoutMs: 2000 });
  const requestedRoot = input && input.tool_input && input.tool_input.repo_root;
  const cwd = typeof requestedRoot === 'string' && requestedRoot ? requestedRoot : hookCwd(input);
  const root = repoRoot(cwd);
  if (!root) return passSilent();
  if (!canUseCrg()) {
    try { startAutoBootstrap(cwd); } catch (_) {}
    return deny('CodeMap graph tool blocked because code-review-graph is not ready. Wait for bootstrap or run codemap-boost-setup, then retry.');
  }
  if (!refreshCrgSync(root)) {
    return deny('CodeMap graph tool blocked because the required build/update did not complete. Retry after the active refresh finishes.');
  }
  const toolInput = input && input.tool_input && typeof input.tool_input === 'object'
    ? input.tool_input
    : {};
  const updatedInput = repoRootUpdate(input && input.tool_name, toolInput, root);
  if (updatedInput) return allowWithRepoRoot(updatedInput, root);
  return passSilent();
}

if (require.main === module) {
  main().catch(() => deny('CodeMap graph tool blocked because the refresh barrier failed.'));
}

module.exports = { ROOT_SCOPED_CRG_TOOLS, repoRootUpdate, shouldInjectRepoRoot };
