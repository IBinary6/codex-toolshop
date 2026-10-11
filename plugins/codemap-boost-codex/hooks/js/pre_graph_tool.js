'use strict';

const { hookCwd, passSilent, readStdinJson, repoRoot } = require('./lib/runtime');
const { prepareCrgForRead } = require('./lib/codemap');

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
 * Allow the tool call and fill CRG repo_root from the current repository root.
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
 * Determine whether this call is a Code Review Graph tool that accepts repo_root.
 * @example shouldInjectRepoRoot('mcp__code_review_graph__query_graph_tool')
 */
function shouldInjectRepoRoot(toolName) {
  const match = /^mcp__(?:code_review_graph|code-review-graph)__(.+)$/.exec(String(toolName || ''));
  return !!match && ROOT_SCOPED_CRG_TOOLS.has(match[1]);
}

/**
 * Resolve cwd or the caller’s explicit directory to a canonical Git worktree root; return null when no rewrite is needed.
 * @example repoRootUpdate('mcp__code_review_graph__query_graph_tool', { target: 'main' }, '/workspace/repo')
 */
function repoRootUpdate(toolName, toolInput, root) {
  if (!shouldInjectRepoRoot(toolName) || toolInput.repo_root === root) return null;
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

/**
 * Convert bounded diagnostics from the Boolean refresh API into a barrier denial reason.
 * Distinguish lock wait from refresh failure so a real build error is not misreported as background refresh still running.
 */
function refreshFailureReason(diagnostics) {
  const diagnostic = Array.isArray(diagnostics) ? diagnostics.at(-1) : null;
  if (diagnostic && diagnostic.code === 'runtime_prepare_failed') {
    return `CodeMap graph tool blocked because the managed runtime preparation failed. ${diagnostic.message}`;
  }
  if (diagnostic && diagnostic.code === 'prepare_budget_exhausted') {
    return `CodeMap graph tool blocked because the graph call preparation budget was exhausted. ${diagnostic.message} Retry the graph call or run setup for diagnostics.`;
  }
  if (diagnostic && diagnostic.code === 'lock_wait_timeout') {
    return `CodeMap graph tool blocked because the refresh lock wait timed out while an active refresh held the repository lock. ${diagnostic.message} Retry after the active refresh finishes.`;
  }
  const detail = diagnostic && diagnostic.message
    ? ` ${diagnostic.message}`
    : ' No additional error detail was reported.';
  return `CodeMap graph tool blocked because the required graph refresh execution failed.${detail}`;
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  // Global repository-registry queries do not read this project graph and must not be blocked by its refresh state.
  if (!shouldInjectRepoRoot(input && input.tool_name)) return passSilent();
  const requestedRoot = input && input.tool_input && input.tool_input.repo_root;
  const cwd = typeof requestedRoot === 'string' && requestedRoot ? requestedRoot : hookCwd(input);
  const root = repoRoot(cwd);
  if (!root) {
    return deny('CodeMap graph tool blocked because the target directory is not inside a Git working tree. Use source/text tools here, or select a valid Git repository or worktree with repo_root.');
  }
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') {
    return deny('CodeMap graph tool blocked because graph support is explicitly disabled for this session.');
  }
  const refreshDiagnostics = [];
  if (!prepareCrgForRead(root, { diagnostics: refreshDiagnostics })) {
    return deny(refreshFailureReason(refreshDiagnostics));
  }
  // Schedule source refresh checks only for actual graph use, independently of the runtime-preparation shared lock.
  try { require('./lib/plugin-updates').schedulePluginUpdate(); } catch (_) {}
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

module.exports = {
  ROOT_SCOPED_CRG_TOOLS,
  refreshFailureReason,
  repoRootUpdate,
  shouldInjectRepoRoot,
};
