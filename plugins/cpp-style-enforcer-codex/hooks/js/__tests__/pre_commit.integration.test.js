const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('child_process');
const path = require('path');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const entry = path.join(pluginRoot, 'hooks', 'js', 'pre_commit.js');
const { commitCwd, isGitCommit } = require(path.join(pluginRoot, 'hooks', 'js', 'pre_commit.js'));

function runHook(command, cwd = process.cwd(), inputCwd = undefined) {
  const r = spawnSync('node', [entry], {
    cwd,
    input: JSON.stringify({ tool_name: 'Bash', cwd: inputCwd, tool_input: { command } }),
    encoding: 'utf-8',
    timeout: 30000,
    windowsHide: process.platform === 'win32',
  });
  return { status: r.status, stdout: (r.stdout || '').trim() };
}

function git(args, cwd) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10000,
    windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(r.status, 0, r.stderr);
}

// isGitCommit 单元断言：真 commit 命中，假阳性放行
assert.strictEqual(isGitCommit('git commit -m "x"'), true, '真 git commit 应命中');
assert.strictEqual(isGitCommit('git commit'), true, '裸 git commit 应命中');
assert.strictEqual(isGitCommit('  git   commit  --amend'), true, '多空格 git commit 应命中');
assert.strictEqual(isGitCommit('git -C repo commit -m "x"'), true, 'git -C repo commit 应命中');
assert.strictEqual(isGitCommit('git -c user.name=x commit -m "x"'), true, 'git -c ... commit 应命中');
assert.strictEqual(isGitCommit('cd repo; git commit -m "x"'), true, '组合命令中的 git commit 应命中');
assert.strictEqual(isGitCommit('cmd /c git commit -m "x"'), true, 'cmd /c git commit 应命中');
assert.strictEqual(isGitCommit('command git commit -m "x"'), true, 'command 包装的 git commit 应命中');
assert.strictEqual(isGitCommit('echo "git commit"'), false, 'echo 内 git commit 不应命中');
assert.strictEqual(isGitCommit('git commit-graph write'), false, 'commit-graph 不应命中');
assert.strictEqual(isGitCommit('git commit-tree HEAD^{tree}'), false, 'commit-tree 不应命中');
assert.strictEqual(isGitCommit('git status'), false, 'git status 不应命中');

{
  const base = path.resolve('base');
  assert.strictEqual(commitCwd('git commit', base), base);
  assert.strictEqual(commitCwd('git -C repo commit -m "x"', base), path.join(base, 'repo'));
  assert.strictEqual(commitCwd('cd repo; git commit -m "x"', base), path.join(base, 'repo'));
}

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

// git -C 指向的仓库有 staged C++ 违规时，应检查目标仓库而不是 hook 进程 cwd。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-scope-'));
  try {
    const repoA = path.join(tmp, 'repo-a');
    const repoB = path.join(tmp, 'repo-b');
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    git(['init'], repoA);
    git(['init'], repoB);
    fs.writeFileSync(path.join(repoB, 'bad.cc'), '#include <vector>\nusing namespace std;\nint main(){return 0;}\n', 'utf8');
    git(['add', 'bad.cc'], repoB);

    const r = runHook(`git -C "${repoB}" commit -m "x"`, repoA);
    assert.strictEqual(r.status, 0, 'hook 协议要求 exit 0');
    const payload = JSON.parse(r.stdout);
    assert.strictEqual(payload.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(payload.hookSpecificOutput.permissionDecisionReason.includes('bad.cc'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('pre_commit.integration.test.js PASS');
