const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('child_process');
const path = require('path');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const entry = path.join(pluginRoot, 'hooks', 'js', 'pre_commit.js');
const cleanupFailureFixture = path.join(__dirname, 'fail_snapshot_cleanup.cjs');
const stagedDiffFailureFixture = path.join(__dirname, 'fail_staged_diff.cjs');
const { commitCwd, isGitCommit, stagedCppFiles } = require(path.join(pluginRoot, 'hooks', 'js', 'pre_commit.js'));

function runHook(command, cwd = process.cwd(), inputCwd = undefined, nodeArgs = []) {
  const r = spawnSync(process.execPath, [...nodeArgs, entry], {
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

// isGitCommit identifies real commits and allows false-positive strings.
assert.strictEqual(isGitCommit('git commit -m "x"'), true, 'Real git commit is detected');
assert.strictEqual(isGitCommit('git commit'), true, 'Bare git commit is detected');
assert.strictEqual(isGitCommit('  git   commit  --amend'), true, 'git commit with extra spaces is detected');
assert.strictEqual(isGitCommit('git -C repo commit -m "x"'), true, 'git -C repo commit is detected');
assert.strictEqual(isGitCommit('git -c user.name=x commit -m "x"'), true, 'git -c ... commit is detected');
assert.strictEqual(isGitCommit('cd repo; git commit -m "x"'), true, 'git commit in a compound command is detected');
assert.strictEqual(isGitCommit('cmd /c git commit -m "x"'), true, 'git commit wrapped in cmd /c is detected');
assert.strictEqual(isGitCommit('GIT COMMIT -m "x"'), true, 'Case-insensitive GIT COMMIT is detected');
assert.strictEqual(isGitCommit('git.exe commit -m "x"'), true, 'Windows git.exe commit is detected');
assert.strictEqual(isGitCommit('/usr/bin/git commit -m "x"'), true, 'git commit with an absolute path is detected');
assert.strictEqual(isGitCommit('"C:\\Program Files\\Git\\cmd\\git.exe" commit -m "x"'), true,
  'Windows git.exe commit with spaces in its absolute path is detected');
assert.strictEqual(isGitCommit('cmd.exe /C git.exe COMMIT -m "x"'), true, 'git.exe commit wrapped in cmd /c is detected');
assert.strictEqual(isGitCommit('cmd /c "C:\\Program Files\\Git\\cmd\\git.exe" commit -m "x"'), true,
  'git.exe commit with spaces in its path is detected through cmd /c');
assert.strictEqual(isGitCommit('cmd.exe /d /s /c git.exe commit -m "x"'), true,
  'cmd /c with common options is detected');
assert.strictEqual(isGitCommit('command git commit -m "x"'), true, 'git commit wrapped in command is detected');
assert.strictEqual(isGitCommit('echo "git commit"'), false, 'git commit inside echo is ignored');
assert.strictEqual(isGitCommit('git commit-graph write'), false, 'commit-graph is ignored');
assert.strictEqual(isGitCommit('git commit-tree HEAD^{tree}'), false, 'commit-tree is ignored');
assert.strictEqual(isGitCommit('git status'), false, 'git status is ignored');

{
  const base = path.resolve('base');
  assert.strictEqual(commitCwd('git commit', base), base);
  assert.strictEqual(commitCwd('git -C repo commit -m "x"', base), path.join(base, 'repo'));
  assert.strictEqual(commitCwd('cd repo; git commit -m "x"', base), path.join(base, 'repo'));
  assert.strictEqual(commitCwd('cd /d "repo with space" && git.exe commit -m "x"', base),
    path.join(base, 'repo with space'));
  assert.strictEqual(commitCwd('cmd /c "cd /d repo && git.exe commit -m x"', base),
    path.join(base, 'repo'), 'Quoted cd in cmd determines the actual commit directory');
}

// Git -z output preserves spaces, Chinese names, and shell metacharacters; POSIX also covers newlines in names.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-paths-'));
  try {
    git(['init'], tmp);
    const names = ['src/with space.cc', 'src/\u4e2d\u6587.cpp', 'src/hash#bracket[1].hpp'];
    if (process.platform !== 'win32') names.push('src/line\nbreak.cc');
    for (const name of names) writeBytes(path.join(tmp, ...name.split('/')), CLEAN_CPP);
    git(['add', '--', ...names], tmp);

    const actual = stagedCppFiles(tmp).map((filePath) => path.relative(tmp, filePath).split(path.sep).join('/'));
    assert.deepStrictEqual(actual.sort(), [...names].sort(), 'Staged filenames are parsed intact using NUL boundaries');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Non-commit command: passSilent (exit 0, empty stdout).
{
  const r = runHook('git status');
  assert.strictEqual(r.status, 0, 'Non-commit command exits 0');
  assert.strictEqual(r.stdout, '', 'Non-commit command leaves stdout empty');
}

// echo mentioning git commit does not trigger lint and passes silently.
{
  const r = runHook('echo "git commit"');
  assert.strictEqual(r.status, 0, 'echo exits 0');
  assert.strictEqual(r.stdout, '', 'echo leaves stdout empty');
}

// When git -C targets a repository with staged violations, check that repository rather than hook cwd.
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
    assert.strictEqual(r.status, 0, 'Hook protocol requires exit 0');
    const payload = JSON.parse(r.stdout);
    assert.strictEqual(payload.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(payload.hookSpecificOutput.permissionDecisionReason.includes('bad.cc'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// If staged LF content is clean but worktree CRLF later has violations, check the clean index version.
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
    assert.strictEqual(r.status, 0, 'Clean staged version passes the commit check');
    assert.strictEqual(r.stdout, '', 'Clean staged version passes silently');
    assert.ok(fs.readFileSync(source).equals(before), 'Commit check leaves the CRLF worktree unchanged');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// If staged LF content violates rules but worktree CRLF is later clean, block by the index version.
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
    assert.strictEqual(r.status, 0, 'Hook protocol requires exit 0');
    const payload = JSON.parse(r.stdout);
    assert.strictEqual(payload.hookSpecificOutput.permissionDecision, 'deny',
      'Noncompliant staged version blocks the commit');
    assert.ok(payload.hookSpecificOutput.permissionDecisionReason.includes('src/main.cc'));
    assert.ok(fs.readFileSync(source).equals(before), 'Commit check leaves the CRLF worktree unchanged');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Use staged CPPLINT.cfg too: a staged casting exclusion applies even when worktree re-enables it.
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
    assert.strictEqual(r.status, 0, 'Staged CPPLINT.cfg allows the corresponding source to pass');
    assert.strictEqual(r.stdout, '', 'Staged CPPLINT.cfg takes effect silently');
    assert.ok(fs.readFileSync(config).equals(before), 'Commit check leaves worktree CPPLINT.cfg unchanged');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Failed staged enumeration is an incomplete check and must deny commit, not act as no C++ files.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-staged-diff-failure-'));
  try {
    git(['init'], tmp);
    writeBytes(path.join(tmp, 'clean.cc'), CLEAN_CPP);
    git(['add', 'clean.cc'], tmp);

    const r = runHook('git commit -m "x"', tmp, undefined, ['--require', stagedDiffFailureFixture]);
    assert.strictEqual(r.status, 0, 'Hook protocol requires exit 0 even when denying a commit');
    const payload = JSON.parse(r.stdout);
    assert.strictEqual(payload.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /staging area|git diff/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Snapshot cleanup failure means incomplete checking and must deny commit rather than fail open.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-cleanup-failure-'));
  try {
    git(['init'], tmp);
    writeBytes(path.join(tmp, 'clean.cc'), CLEAN_CPP);
    git(['add', 'clean.cc'], tmp);

    const r = runHook('git commit -m "x"', tmp, undefined, ['--require', cleanupFailureFixture]);
    assert.strictEqual(r.status, 0, 'Hook protocol requires exit 0 even when denying a commit');
    const payload = JSON.parse(r.stdout);
    assert.strictEqual(payload.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /clean up.*snapshot|snapshot.*clean up/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Explicit legacyChecks.cpplint also checks previously committed files.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-legacy-checks-'));
  try {
    git(['init'], tmp);
    git(['config', 'user.email', 'test@example.invalid'], tmp);
    git(['config', 'user.name', 'test'], tmp);
    git(['config', 'commit.gpgsign', 'false'], tmp);
    writeBytes(path.join(tmp, 'legacy.cc'), CLEAN_CPP);
    git(['add', 'legacy.cc'], tmp);
    git(['commit', '-m', 'baseline'], tmp);
    writeBytes(path.join(tmp, '.codex-cpp-style', 'cpp-style.json'), Buffer.from(JSON.stringify({
      mode: 'incremental', checks: { cpplint: false },
      legacyChecks: { cpplint: true, copyright: false },
    })));
    writeBytes(path.join(tmp, 'legacy.cc'), VIOLATION_CPP);
    git(['add', 'legacy.cc'], tmp);
    const result = runHook('git commit -m "check legacy"', tmp);
    assert.strictEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /legacy.cc/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('pre_commit.integration.test.js PASS');
