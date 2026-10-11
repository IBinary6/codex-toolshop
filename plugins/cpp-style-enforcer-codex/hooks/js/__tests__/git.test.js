const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { repoRoot, isNew, changedLineRanges } = require('../lib/git.js');

function sh(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
}

// Create a temporary Git repository.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gittest-'));
sh(['init'], tmp);
sh(['config', 'user.email', 't@t.com'], tmp);
sh(['config', 'user.name', 't'], tmp);
const tracked = path.join(tmp, 'tracked.cpp');
fs.writeFileSync(tracked, 'int a;');
sh(['add', 'tracked.cpp'], tmp);
sh(['commit', '--no-gpg-sign', '-m', 'init'], tmp);
const untracked = path.join(tmp, 'untracked.cpp');
fs.writeFileSync(untracked, 'int b;');

let empty;
let aliasParent;

try {
  const root = repoRoot(tracked);
  assert.ok(root && fs.existsSync(root), 'repoRoot returns an existing directory');
  assert.strictEqual(isNew(tracked, root), false, 'Tracked file has isNew=false');
  assert.strictEqual(isNew(untracked, root), true, 'Untracked file has isNew=true');

  // Windows CI TEMP may use an 8.3 alias such as RUNNER~1 while git rev-parse returns a long path.
  // Use a junction or symlink to reproduce one repository represented by different paths.
  aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gitalias-'));
  const aliasRoot = path.join(aliasParent, 'repo-alias');
  fs.symlinkSync(tmp, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasTracked = path.join(aliasRoot, 'tracked.cpp');
  const canonicalRoot = repoRoot(aliasTracked);
  assert.strictEqual(isNew(aliasTracked, canonicalRoot), false,
    'A path alias to a tracked file still identifies it as old');

  // Regression: an added but uncommitted initial file is absent from HEAD and remains new.
  const staged = path.join(tmp, 'staged.cpp');
  fs.writeFileSync(staged, 'int s;');
  sh(['add', 'staged.cpp'], tmp);
  assert.strictEqual(isNew(staged, root), true, 'Added but uncommitted file remains new');

  // Empty repository: without commits or HEAD, every file is new.
  empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gitempty-'));
  sh(['init'], empty);
  const emptyRoot = repoRoot(path.join(empty, 'probe'));
  const ef = path.join(empty, 'e.cpp');
  fs.writeFileSync(ef, 'int e;');
  sh(['add', 'e.cpp'], empty);
  assert.strictEqual(isNew(ef, emptyRoot), true, 'Any file in an empty repository is new');

  // Non-Git directory.
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'nongit-'));
  const f = path.join(nonGit, 'x.cpp');
  fs.writeFileSync(f, 'int c;');
  assert.strictEqual(repoRoot(f), null, 'Outside Git, repoRoot is null');
  assert.strictEqual(isNew(f, null), true, 'Outside Git, all files are new');

  // changedLineRanges: parse the changed range after one edit to a tracked file.
  const multi = path.join(tmp, 'multi.cpp');
  fs.writeFileSync(multi, 'int a;\nint b;\nint c;\nint d;\n');
  sh(['add', 'multi.cpp'], tmp);
  sh(['commit', '--no-gpg-sign', '-m', 'multi'], tmp);
  fs.writeFileSync(multi, 'int a;\nint b;\nint cc;\nint d;\n'); // Change line 3.
  const ranges = changedLineRanges(multi, root);
  assert.ok(Array.isArray(ranges), 'changedLineRanges returns an array');
  assert.deepStrictEqual(ranges, [[3, 3]], 'Only line 3 changed');

  // Unchanged tracked file: empty array.
  assert.deepStrictEqual(changedLineRanges(tracked, root), [], 'No changes produce []');

  // Outside Git: null.
  const nonGitR = fs.mkdtempSync(path.join(os.tmpdir(), 'nongit-cr-'));
  const nf = path.join(nonGitR, 'y.cpp');
  fs.writeFileSync(nf, 'int z;\n');
  assert.strictEqual(changedLineRanges(nf, null), null, 'Outside Git: null.');
  fs.rmSync(nonGitR, { recursive: true, force: true });

  console.log('git.test.js PASS');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(aliasParent, { recursive: true, force: true });
  fs.rmSync(nonGit, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
} catch (e) {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (aliasParent) fs.rmSync(aliasParent, { recursive: true, force: true });
  if (empty) fs.rmSync(empty, { recursive: true, force: true });
  throw e;
}
