const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const entry = path.join(pluginRoot, 'hooks', 'js', 'pre_commit.js');
const { isGitCommit } = require(path.join(pluginRoot, 'hooks', 'js', 'pre_commit.js'));

function runHook(command) {
  const r = spawnSync('node', [entry], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf-8',
    timeout: 30000,
  });
  return { status: r.status, stdout: (r.stdout || '').trim() };
}

// isGitCommit 单元断言：真 commit 命中，假阳性放行
assert.strictEqual(isGitCommit('git commit -m "x"'), true, '真 git commit 应命中');
assert.strictEqual(isGitCommit('git commit'), true, '裸 git commit 应命中');
assert.strictEqual(isGitCommit('  git   commit  --amend'), true, '多空格 git commit 应命中');
assert.strictEqual(isGitCommit('echo "git commit"'), false, 'echo 内 git commit 不应命中');
assert.strictEqual(isGitCommit('git commit-graph write'), false, 'commit-graph 不应命中');
assert.strictEqual(isGitCommit('git commit-tree HEAD^{tree}'), false, 'commit-tree 不应命中');
assert.strictEqual(isGitCommit('git status'), false, 'git status 不应命中');

// 非 commit 命令 → passSilent（exit 0，stdout 空）
{
  const r = runHook('git status');
  assert.strictEqual(r.status, 0, '非 commit 应 exit 0');
  assert.strictEqual(r.stdout, '', '非 commit 应 stdout 空');
}

// echo 含 git commit → 不触发 lint，passSilent
{
  const r = runHook('echo "git commit"');
  assert.strictEqual(r.status, 0, 'echo 应 exit 0');
  assert.strictEqual(r.stdout, '', 'echo 应 stdout 空');
}

console.log('pre_commit.integration.test.js PASS');
