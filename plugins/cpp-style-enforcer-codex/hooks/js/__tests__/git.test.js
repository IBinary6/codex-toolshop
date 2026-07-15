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

// 建临时 git 仓库
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
  assert.ok(root && fs.existsSync(root), 'repoRoot 应返回有效目录');
  assert.strictEqual(isNew(tracked, root), false, '已跟踪 = 老文件 isNew=false');
  assert.strictEqual(isNew(untracked, root), true, '未跟踪 = 新文件 isNew=true');

  // Windows CI 的 TEMP 可能使用 RUNNER~1 这类 8.3 别名，而 git rev-parse 返回长路径。
  // 用目录联接/符号链接稳定复现“同一仓库、不同路径表示”边界。
  aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gitalias-'));
  const aliasRoot = path.join(aliasParent, 'repo-alias');
  fs.symlinkSync(tmp, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasTracked = path.join(aliasRoot, 'tracked.cpp');
  const canonicalRoot = repoRoot(aliasTracked);
  assert.strictEqual(isNew(aliasTracked, canonicalRoot), false,
    '路径别名指向的已跟踪文件仍应识别为老文件');

  // 核心回归：已 git add 但未 commit 的首次提交新文件 → 不在 HEAD → 新文件
  const staged = path.join(tmp, 'staged.cpp');
  fs.writeFileSync(staged, 'int s;');
  sh(['add', 'staged.cpp'], tmp);
  assert.strictEqual(isNew(staged, root), true, '已 add 未 commit 新文件 = 新文件 isNew=true');

  // 空仓库边界：无任何 commit 时，HEAD 不存在 → 任意文件视为新文件
  empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gitempty-'));
  sh(['init'], empty);
  const emptyRoot = repoRoot(path.join(empty, 'probe'));
  const ef = path.join(empty, 'e.cpp');
  fs.writeFileSync(ef, 'int e;');
  sh(['add', 'e.cpp'], empty);
  assert.strictEqual(isNew(ef, emptyRoot), true, '空仓库(无 commit)任意文件 isNew=true');

  // 非 git 仓库
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'nongit-'));
  const f = path.join(nonGit, 'x.cpp');
  fs.writeFileSync(f, 'int c;');
  assert.strictEqual(repoRoot(f), null, '非 git repoRoot=null');
  assert.strictEqual(isNew(f, null), true, '非 git 所有文件视为新 isNew=true');

  // changedLineRanges：已跟踪文件改一行 → 解析出对应改动行范围
  const multi = path.join(tmp, 'multi.cpp');
  fs.writeFileSync(multi, 'int a;\nint b;\nint c;\nint d;\n');
  sh(['add', 'multi.cpp'], tmp);
  sh(['commit', '--no-gpg-sign', '-m', 'multi'], tmp);
  fs.writeFileSync(multi, 'int a;\nint b;\nint cc;\nint d;\n'); // 改第 3 行
  const ranges = changedLineRanges(multi, root);
  assert.ok(Array.isArray(ranges), 'changedLineRanges 返回数组');
  assert.deepStrictEqual(ranges, [[3, 3]], '仅第 3 行改动 → [[3,3]]');

  // 未改动的已跟踪文件 → 空数组
  assert.deepStrictEqual(changedLineRanges(tracked, root), [], '无改动 → []');

  // 非 git → null
  const nonGitR = fs.mkdtempSync(path.join(os.tmpdir(), 'nongit-cr-'));
  const nf = path.join(nonGitR, 'y.cpp');
  fs.writeFileSync(nf, 'int z;\n');
  assert.strictEqual(changedLineRanges(nf, null), null, '非 git → null');
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
