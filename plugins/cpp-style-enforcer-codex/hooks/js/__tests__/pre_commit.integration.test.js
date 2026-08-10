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

const CLEAN_CPP = Buffer.from('int main() { return 0; }\n', 'utf8');
const VIOLATION_CPP = Buffer.from(
  'int main() {\n  double d = 3.5;\n  int y = (int)d;\n  return y;\n}\n',
  'utf8',
);

function writeBytes(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
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

// 暂存区是 LF、工作区后来改成 CRLF 且存在违规时，必须检查 index 的干净版本，不能误读工作区。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-index-lf-'));
  try {
    git(['init'], tmp);
    const source = path.join(tmp, 'src', 'main.cc');
    writeBytes(source, CLEAN_CPP);
    git(['add', 'src/main.cc'], tmp);

    const worktreeViolation = Buffer.from(VIOLATION_CPP.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
    writeBytes(source, worktreeViolation);
    const before = fs.readFileSync(source);

    const r = runHook(`git commit -m "x"`, tmp);
    assert.strictEqual(r.status, 0, '暂存区干净版本应通过提交检查');
    assert.strictEqual(r.stdout, '', '暂存区干净版本通过时应静默');
    assert.ok(fs.readFileSync(source).equals(before), '提交检查不得改写 CRLF 工作区');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 暂存区是 LF 且存在违规、工作区后来变成干净 CRLF 时，必须按 index 版本阻止提交。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-index-violation-'));
  try {
    git(['init'], tmp);
    const source = path.join(tmp, 'src', 'main.cc');
    writeBytes(source, VIOLATION_CPP);
    git(['add', 'src/main.cc'], tmp);

    const worktreeClean = Buffer.from(CLEAN_CPP.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
    writeBytes(source, worktreeClean);
    const before = fs.readFileSync(source);

    const r = runHook(`git commit -m "x"`, tmp);
    assert.strictEqual(r.status, 0, 'hook 协议要求 exit 0');
    const payload = JSON.parse(r.stdout);
    assert.strictEqual(payload.hookSpecificOutput.permissionDecision, 'deny',
      '暂存区违规版本必须阻止提交');
    assert.ok(payload.hookSpecificOutput.permissionDecisionReason.includes('src/main.cc'));
    assert.ok(fs.readFileSync(source).equals(before), '提交检查不得改写 CRLF 工作区');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// CPPLINT.cfg 也必须取 index 版本：暂存配置关闭 casting 检查时应生效，即使工作区已重新开启。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-index-cpplint-'));
  try {
    git(['init'], tmp);
    const source = path.join(tmp, 'src', 'main.cc');
    const config = path.join(tmp, 'CPPLINT.cfg');
    writeBytes(source, VIOLATION_CPP);
    writeBytes(config, Buffer.from('set noparent\nfilter=-readability/casting\n', 'utf8'));
    git(['add', 'src/main.cc', 'CPPLINT.cfg'], tmp);

    const worktreeConfig = Buffer.from('set noparent\nfilter=+readability/casting\n', 'utf8');
    writeBytes(config, worktreeConfig);
    const before = fs.readFileSync(config);

    const r = runHook(`git commit -m "x"`, tmp);
    assert.strictEqual(r.status, 0, '暂存 CPPLINT.cfg 应使对应源码通过检查');
    assert.strictEqual(r.stdout, '', '暂存 CPPLINT.cfg 生效时应静默');
    assert.ok(fs.readFileSync(config).equals(before), '提交检查不得改写工作区 CPPLINT.cfg');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('pre_commit.integration.test.js PASS');
