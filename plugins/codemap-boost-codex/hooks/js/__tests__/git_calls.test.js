'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Count git invocations: the stub must be installed before the libraries destructure spawnSync.
const calls = [];
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function counted(command, args, ...rest) {
  if (command === 'git') calls.push(args.join(' '));
  return realSpawnSync.call(this, command, args, ...rest);
};

const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-git-calls-')));
process.env.PLUGIN_DATA = path.join(temporary, 'data');
const git = (cwd, ...args) => realSpawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
const repo = path.join(temporary, 'repo');
fs.mkdirSync(repo);
git(repo, 'init', '-q');
git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');

const { gitPath, repoRoot } = require('../lib/runtime');
const { cleanLegacyCrgGitHook, ensureGitInfoExclude } = require('../lib/codemap');

try {
  // What SessionStart asks about one repository: the root three times, then the hook and exclude paths.
  calls.length = 0;
  assert.equal(repoRoot(repo), repo);
  assert.equal(repoRoot(repo), repo);
  assert.equal(ensureGitInfoExclude(repo), true);
  assert.equal(cleanLegacyCrgGitHook(repo), false, 'no legacy hook is present');
  assert.equal(calls.length, 2, `one call for the root and one for both git paths, saw: ${calls.join(' | ')}`);
  assert.equal(calls[0], 'rev-parse --show-toplevel');
  assert.ok(calls[1].includes('--git-path hooks/pre-commit') && calls[1].includes('--git-path info/exclude'), calls[1]);
  const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.includes('.code-review-graph/') && exclude.includes('graphify-out/'));

  // The answers match git's own, including in a linked worktree where .git is a file.
  const linked = path.join(temporary, 'linked');
  git(repo, 'worktree', 'add', '-q', '--detach', linked);
  const linkedRoot = repoRoot(linked);
  assert.equal(linkedRoot, linked);
  for (const relative of ['hooks/pre-commit', 'info/exclude']) {
    const expected = path.resolve(linked, git(linked, 'rev-parse', '--git-path', relative));
    assert.equal(gitPath(linkedRoot, relative), expected, `${relative} in a linked worktree`);
  }
  assert.equal(ensureGitInfoExclude(linked), true);

  // A directory that is not a repository yet is not remembered as "not a repository".
  const later = path.join(temporary, 'later');
  fs.mkdirSync(later);
  assert.equal(repoRoot(later), null);
  git(later, 'init', '-q');
  assert.equal(repoRoot(later), later);
  assert.equal(gitPath(path.join(temporary, 'not-a-repo'), 'info/exclude'), '');
} finally {
  childProcess.spawnSync = realSpawnSync;
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log('git_calls.test.js PASS');
