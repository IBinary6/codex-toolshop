'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  listLinkedWorktrees,
  refreshCrgSync,
  refreshLinkedWorktreesSync,
} = require('../lib/codemap');
const { bashMayChangeSources } = require('../post_tool_use');
const { ROOT_SCOPED_CRG_TOOLS, repoRootUpdate, shouldInjectRepoRoot } = require('../pre_graph_tool');

const postToolSource = fs.readFileSync(path.join(__dirname, '..', 'post_tool_use.js'), 'utf8');

function git(cwd, args, env = process.env) {
  const result = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return (result.stdout || '').trim();
}

function canonicalPath(filePath) {
  const realpath = fs.realpathSync.native || fs.realpathSync;
  return realpath(filePath);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-refresh-'));
const oldDisable = process.env.CODEMAP_BOOST_DISABLE_GRAPH;
try {
  assert.ok(ROOT_SCOPED_CRG_TOOLS.has('semantic_search_nodes_tool'));
  assert.deepStrictEqual(
    shouldInjectRepoRoot('mcp__code_review_graph__query_graph_tool'),
    true,
    'project graph tools receive the task repository root instead of the plugin launcher cwd'
  );
  assert.strictEqual(
    shouldInjectRepoRoot('mcp__code_review_graph__list_repos_tool'),
    false,
    'cross-repository registry tools keep their original schema'
  );
  assert.strictEqual(
    shouldInjectRepoRoot('mcp__graphify__query_graph_tool'),
    false,
    'unrelated graph MCP schemas are not rewritten'
  );
  assert.deepStrictEqual(
    repoRootUpdate(
      'mcp__code_review_graph__semantic_search_nodes_tool',
      { query: 'auth' },
      'C:/workspace/repo'
    ),
    { query: 'auth', repo_root: 'C:/workspace/repo' },
    'the graph call is rewritten to the active task repository'
  );
  assert.strictEqual(
    repoRootUpdate(
      'mcp__code_review_graph__semantic_search_nodes_tool',
      { query: 'auth', repo_root: 'D:/explicit' },
      'D:/explicit'
    ),
    null,
    'an explicit repository already equal to its resolved Git root is preserved'
  );
  assert.deepStrictEqual(repoRootUpdate(
    'mcp__code_review_graph__query_graph_tool',
    { target: 'main', repo_root: 'D:/explicit/nested' },
    'D:/explicit'
  ), { target: 'main', repo_root: 'D:/explicit' }, 'explicit subdirectories use the same Git root as the refresh barrier');

  assert.ok(postToolSource.includes('startCrgUpdate'), 'PostToolUse must refresh in the background');
  assert.ok(!postToolSource.includes('refreshCrgSync(cwd)'), 'PostToolUse must not block on a synchronous refresh');

  for (const command of [
    'git status',
    'git diff --stat',
    'git rev-list --left-right --count origin/main...HEAD',
    'rg TODO src',
    'Get-Content README.md',
    'Get-Process -Id 1234',
    'Get-Item file.txt',
    'tasklist /FI "IMAGENAME eq node.exe"',
    'npm test',
  ]) {
    assert.strictEqual(bashMayChangeSources(command), false, `${command} must not trigger a graph refresh`);
  }
  for (const command of ['git worktree add ../wt', 'git switch feature', 'Set-Content a.cpp x', 'node generate.js', 'rg old src | Set-Content out.txt']) {
    assert.strictEqual(bashMayChangeSources(command), true, `${command} must trigger a graph refresh`);
  }

  delete process.env.CODEMAP_BOOST_DISABLE_GRAPH;
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'CodeMap Test']);
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'function tracked() {}\n');
  git(repo, ['add', 'tracked.js']);
  git(repo, ['commit', '-m', 'init']);
  fs.mkdirSync(path.join(repo, '.code-review-graph'));

  const registryData = path.join(tmp, 'registry-only-data');
  const registry = spawnSync(process.execPath, [path.join(__dirname, '..', 'pre_graph_tool.js')], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, tool_name: 'mcp__code_review_graph__list_repos_tool', tool_input: {} }),
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: registryData, CODEMAP_BOOST_DISABLE_BOOTSTRAP: '1' },
    windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(registry.status, 0, registry.stderr);
  assert.strictEqual(registry.stdout, '', 'registry queries must not be denied by an unrelated project refresh');
  assert.ok(!fs.existsSync(registryData), 'registry queries must not initialize project graph state');

  const calls = [];
  const options = {
    canUseCrg: () => true,
    runCrg: (args, runOptions) => {
      const index = runOptions.env && runOptions.env.GIT_INDEX_FILE;
      calls.push({ args: [...args], index, files: index ? git(repo, ['ls-files'], runOptions.env) : '' });
      return { status: 0 };
    },
  };

  assert.strictEqual(refreshCrgSync(repo, options), true);
  assert.strictEqual(refreshCrgSync(repo, options), true, 'an unchanged source state is already fresh');
  assert.strictEqual(calls[0].args[0], 'update', 'existing graph performs incremental update');
  assert.strictEqual(calls.length, 1, 'an unchanged source state does not invoke CRG twice');

  fs.writeFileSync(path.join(repo, 'tracked.js'), 'function trackedChanged() {}\n');
  assert.strictEqual(refreshCrgSync(repo, options), true);
  assert.strictEqual(calls[1].args[0], 'update', 'a tracked source edit performs an incremental update');

  fs.writeFileSync(path.join(repo, 'new-source.js'), 'function added() {}\n');
  assert.strictEqual(git(repo, ['diff', '--cached', '--name-only']), '', 'real index starts clean');
  assert.strictEqual(refreshCrgSync(repo, options), true);
  assert.strictEqual(calls[2].args[0], 'build', 'untracked source forces a full build');
  assert.ok(calls[2].index, 'full build uses a temporary Git index');
  assert.ok(calls[2].files.split(/\r?\n/).includes('new-source.js'), 'temporary index includes untracked source');
  assert.strictEqual(refreshCrgSync(repo, options), true);
  assert.strictEqual(calls.length, 3, 'the same untracked source state does not repeat a full build');
  assert.strictEqual(git(repo, ['diff', '--cached', '--name-only']), '', 'real index stays untouched');

  const worktree = path.join(tmp, 'worktree');
  git(repo, ['worktree', 'add', '-b', 'codemap-test-worktree', worktree]);
  fs.mkdirSync(path.join(worktree, '.code-review-graph'));
  const roots = listLinkedWorktrees(repo);
  assert.ok(roots.includes(canonicalPath(repo)), 'main worktree is listed');
  assert.ok(roots.includes(canonicalPath(worktree)), 'new worktree is listed');

  const linkedCalls = [];
  assert.strictEqual(refreshLinkedWorktreesSync(repo, {
    canUseCrg: () => true,
    runCrg: (args, runOptions) => {
      linkedCalls.push({ args, cwd: runOptions.cwd });
      return { status: 0 };
    },
  }), true);
  assert.ok(!linkedCalls.some((call) => canonicalPath(call.cwd) === canonicalPath(repo)), 'already-fresh main graph is skipped');
  assert.ok(linkedCalls.some((call) => canonicalPath(call.cwd) === canonicalPath(worktree)), 'new worktree graph refreshed');

  const stateFile = path.join(repo, '.code-review-graph', '.codemap-boost-source-state');
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'function beforeRefresh() {}\n');
  assert.strictEqual(refreshCrgSync(repo, {
    canUseCrg: () => true,
    runCrg: () => {
      fs.writeFileSync(path.join(repo, 'tracked.js'), 'function duringRefresh() {}\n');
      return { status: 0 };
    },
  }), false, 'a successful child exit cannot verify a concurrently changed source state');
  assert.ok(!fs.existsSync(stateFile), 'a concurrent change removes the old success marker');
  assert.strictEqual(refreshCrgSync(repo, {
    canUseCrg: () => true,
    runCrg: () => ({ status: 1 }),
  }), false, 'adapter failure leaves the graph unverified');
  assert.ok(!fs.existsSync(stateFile));
  assert.strictEqual(refreshCrgSync(repo, options), true, 'the stable next attempt can recover');

  fs.writeFileSync(stateFile, 'legacy-unverified-state\n');
  const beforeMigration = calls.length;
  assert.strictEqual(refreshCrgSync(repo, options), true, 'an old marker is revalidated through the new adapter');
  assert.strictEqual(refreshCrgSync(repo, options), true);
  assert.strictEqual(calls.length, beforeMigration + 1, 'the migrated stable state is cached again');

  git(repo, ['switch', '-c', 'same-head-branch']);
  const beforeBranch = calls.length;
  assert.strictEqual(refreshCrgSync(repo, options), true);
  assert.strictEqual(calls.length, beforeBranch + 1, 'a same-SHA branch switch still refreshes provenance');

  fs.writeFileSync(path.join(repo, 'schema.proto'), 'syntax = "proto3";\nmessage Example {}\n');
  assert.strictEqual(refreshCrgSync(repo, options), true);
  assert.ok(calls.at(-1).files.split(/\r?\n/).includes('schema.proto'), 'CRG selects languages from all non-ignored untracked files');
  const beforeUnknownEdit = calls.length;
  fs.writeFileSync(path.join(repo, 'schema.proto'), 'syntax = "proto3";\nmessage Changed {}\n');
  assert.strictEqual(refreshCrgSync(repo, options), true);
  assert.strictEqual(calls.length, beforeUnknownEdit + 1, 'content changes outside the old JS extension list invalidate the marker');

  console.log('refresh.test.js PASS');
} finally {
  if (oldDisable === undefined) delete process.env.CODEMAP_BOOST_DISABLE_GRAPH;
  else process.env.CODEMAP_BOOST_DISABLE_GRAPH = oldDisable;
  fs.rmSync(tmp, { recursive: true, force: true });
}
