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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-refresh-'));
const oldDisable = process.env.CODEMAP_BOOST_DISABLE_GRAPH;
try {
  for (const command of ['git status', 'git diff --stat', 'rg TODO src', 'Get-Content README.md', 'npm test']) {
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
  assert.strictEqual(refreshCrgSync(repo, options), true, 'refresh is not throttled after a second edit');
  assert.strictEqual(calls[0].args[0], 'update', 'existing graph performs incremental update');
  assert.strictEqual(calls[1].args[0], 'update', 'every refresh request reaches CRG');

  fs.writeFileSync(path.join(repo, 'new-source.js'), 'function added() {}\n');
  assert.strictEqual(git(repo, ['diff', '--cached', '--name-only']), '', 'real index starts clean');
  assert.strictEqual(refreshCrgSync(repo, options), true);
  assert.strictEqual(calls[2].args[0], 'build', 'untracked source forces a full build');
  assert.ok(calls[2].index, 'full build uses a temporary Git index');
  assert.ok(calls[2].files.split(/\r?\n/).includes('new-source.js'), 'temporary index includes untracked source');
  assert.strictEqual(git(repo, ['diff', '--cached', '--name-only']), '', 'real index stays untouched');

  const worktree = path.join(tmp, 'worktree');
  git(repo, ['worktree', 'add', '-b', 'codemap-test-worktree', worktree]);
  fs.mkdirSync(path.join(worktree, '.code-review-graph'));
  const roots = listLinkedWorktrees(repo);
  assert.ok(roots.includes(path.resolve(repo)), 'main worktree is listed');
  assert.ok(roots.includes(path.resolve(worktree)), 'new worktree is listed');

  const linkedCalls = [];
  assert.strictEqual(refreshLinkedWorktreesSync(repo, {
    canUseCrg: () => true,
    runCrg: (args, runOptions) => {
      linkedCalls.push({ args, cwd: runOptions.cwd });
      return { status: 0 };
    },
  }), true);
  assert.ok(linkedCalls.some((call) => path.resolve(call.cwd) === path.resolve(repo)), 'main graph refreshed');
  assert.ok(linkedCalls.some((call) => path.resolve(call.cwd) === path.resolve(worktree)), 'new worktree graph refreshed');

  console.log('refresh.test.js PASS');
} finally {
  if (oldDisable === undefined) delete process.env.CODEMAP_BOOST_DISABLE_GRAPH;
  else process.env.CODEMAP_BOOST_DISABLE_GRAPH = oldDisable;
  fs.rmSync(tmp, { recursive: true, force: true });
}
