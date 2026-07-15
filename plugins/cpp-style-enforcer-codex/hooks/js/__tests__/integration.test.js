'use strict';

// 集成回归测试（spec §10）：在临时 git 仓库 spawnSync 子进程跑入口脚本，
// 喂 stdin，断言 (exit/stdout/stderr) 固化崩溃修复后的行为契约。
// PostToolUse 延迟记录 + Stop 统一处理场景 a-e + pre_commit denyTool/passSilent。

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const postEdit = path.join(__dirname, '..', 'post_edit.js');
const stopCheck = path.join(__dirname, '..', 'stop_check.js');
const preCommit = path.join(__dirname, '..', 'pre_commit.js');
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

function sh(args, cwd) { spawnSync('git', args, { cwd, stdio: 'pipe' }); }

// 隔离 HOME，避免读到真实全局模板（用硬编码默认 incremental 配置）
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-inthome-'));
const env = {
  ...process.env,
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  PLUGIN_DATA: path.join(fakeHome, 'plugin-data'),
};

const repos = [];
function newRepo(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'cse-int-'));
  repos.push(tmp);
  sh(['init'], tmp);
  sh(['config', 'user.email', 't@t.com'], tmp);
  sh(['config', 'user.name', 't'], tmp);
  sh(['config', 'commit.gpgsign', 'false'], tmp);
  return tmp;
}

let turnCounter = 0;
function runDeferred(input) {
  turnCounter += 1;
  const hookInput = {
    session_id: 'integration-session',
    turn_id: `turn-${turnCounter}`,
    tool_use_id: `tool-${turnCounter}`,
    ...input,
  };
  const cwd = input.cwd || process.cwd();
  const post = spawnSync('node', [postEdit], {
    input: JSON.stringify(hookInput), encoding: 'utf-8', timeout: 30000, env, cwd,
  });
  const stop = spawnSync('node', [stopCheck], {
    input: JSON.stringify({
      session_id: hookInput.session_id,
      turn_id: hookInput.turn_id,
      cwd,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }),
    encoding: 'utf-8', timeout: 30000, env, cwd,
  });
  return { post, stop };
}

function runPost(input) {
  return spawnSync('node', [postEdit], {
    input: JSON.stringify(input), encoding: 'utf-8', timeout: 30000, env,
  });
}

function runPreCommit(input, cwd) {
  return spawnSync('node', [preCommit], {
    input: JSON.stringify(input), encoding: 'utf-8', timeout: 30000, env, cwd,
  });
}

const hasPython = spawnSync('python', ['--version'], { stdio: 'pipe' }).status === 0
  || spawnSync('python3', ['--version'], { stdio: 'pipe' }).status === 0;

try {
  // ---- 场景 (a)：未配置项目编辑已存在(已 git 跟踪).cpp → 旧崩溃场景现在 passSilent ----
  // 老文件 incremental → 只补 BOM、不格式化/不 lint；绝不 exit2+JSON block。
  {
    const repo = newRepo('cse-a-');
    const f = path.join(repo, 'old.cpp');
    // 故意杂乱格式 + 无版权头：若被当成全套会被格式化/插头，断言可捕获
    fs.writeFileSync(f, 'int  old_var( ){return 0;}\n');
    sh(['add', 'old.cpp'], repo);
    sh(['commit', '-m', 'init'], repo);

    const { post, stop } = runDeferred({ cwd: repo, tool_name: 'Edit', tool_input: { file_path: f } });
    assert.strictEqual(post.status, 0, '场景a: 老文件编辑 exit 0（不崩溃）');
    assert.strictEqual((post.stdout || '').trim(), '', '场景a: 编辑阶段只记录、不 block');
    assert.strictEqual(stop.status, 0, '场景a: Stop 统一处理 exit 0');
    assert.strictEqual(JSON.parse(stop.stdout).decision, 'block', '场景a: 规范化后要求最终验证');

    const out = fs.readFileSync(f);
    assert.ok(out.slice(0, 3).equals(BOM), '场景a: 老文件只补 BOM');
    const bodyText = out.slice(3).toString('utf-8');
    assert.ok(bodyText.includes('int  old_var( ){return 0;}'), '场景a: 老文件正文未被 clang-format');
    assert.ok(!/Copyright/.test(bodyText), '场景a: 老文件未插版权头');
  }

  // ---- 场景 (c)：与 (a) 同一契约的显式重述（老文件 incremental 只补 BOM）----
  // 已在场景 a 覆盖：已 git 跟踪文件不格式化/不 lint，仅 BOM。此处不再重复仓库。

  // ---- 场景 (d)：enabled:false → 完全 no-op（exit0 无输出 + 文件字节零改动）----
  {
    const repo = newRepo('cse-d-');
    const cfgDir = path.join(repo, '.claude-cpp-style');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({ enabled: false }));
    const f = path.join(repo, 'noop.cpp');
    // 新文件 + 杂乱格式 + 无 BOM：enabled:false 必须一字节都不动
    fs.writeFileSync(f, 'int  main( ){int x=1;return x;}\n');
    const before = fs.readFileSync(f);

    const { post, stop } = runDeferred({ cwd: repo, tool_name: 'Write', tool_input: { file_path: f } });
    assert.strictEqual(post.status, 0, '场景d: enabled:false exit 0');
    assert.strictEqual((post.stdout || '').trim(), '', '场景d: 编辑阶段 stdout 空');
    assert.deepStrictEqual(JSON.parse(stop.stdout), {}, '场景d: Stop no-op');
    assert.ok(fs.readFileSync(f).equals(before), '场景d: enabled:false 文件字节零改动');
  }

  // ---- 场景 (e)：Bash 误喂（无 file_path）→ passSilent；并验证单进程（无子 node 链）----
  {
    const repo = newRepo('cse-e-');
    const start = Date.now();
    const r = runPost({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'echo "edit a.cpp"' } });
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0, '场景e: Bash 误喂 exit 0');
    assert.strictEqual((r.stdout || '').trim(), '', '场景e: 无 file_path → passSilent stdout 空');
    // 单进程流水线：至多 spawn git/python/clang-format，不再 spawn 子 node。整体耗时合理。
    assert.ok(elapsed < 30000, '场景e: 单进程流水线耗时合理 (<30s)');
  }
  // 静态验证：post_edit.js 入口不 spawn node 子进程（无子 node 进程链）
  {
    const srcPost = fs.readFileSync(postEdit, 'utf-8');
    assert.ok(!/spawn[A-Za-z]*\(\s*['"]node['"]/.test(srcPost),
      '场景e: post_edit.js 不 spawn node 子进程（单进程流水线）');
  }

  // C-style cast 触发 cpplint readability/casting 违规；clang-format 不会修复它，
  // 因此走完整流水线（clang-format → ... → cpplint）后违规仍在 → 必触发 block/deny。
  // （不能用长行/紧贴大括号：clang-format 会拆行/补空格把违规消除掉。）
  const VIOLATION_CPP = 'int main() {\n  double d = 3.5;\n  int y = (int)d;\n  return y;\n}\n';

  // ---- 场景 (b)：新文件 + cpplint 违规 → exit0 + stdout 含 decision:block JSON（需 python+cpplint）----
  if (hasPython) {
    const repo = newRepo('cse-b-');
    const f = path.join(repo, 'new.cpp');
    // 未跟踪新文件 → incremental 走全套
    fs.writeFileSync(f, VIOLATION_CPP);

    const { post, stop } = runDeferred({ cwd: repo, tool_name: 'Write', tool_input: { file_path: f } });
    assert.strictEqual(post.status, 0, '场景b: 编辑阶段 exit 0');
    assert.strictEqual((post.stdout || '').trim(), '', '场景b: 编辑阶段不检查、不 block');
    assert.strictEqual(stop.status, 0, '场景b: Stop 检查 exit 0（绝不 exit 2）');
    const stdout = (stop.stdout || '').trim();
    assert.ok(stdout.length > 0, '场景b: Stop 发现违规必产出 stdout（block）');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', '场景b: 新文件违规 → decision:block JSON');
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0, '场景b: reason 非空');
    assert.ok(/casting/.test(parsed.reason), '场景b: reason 含 readability/casting 违规');
  }

  // ---- pre_commit 集成：暂存含违规 .cpp + 真 git commit 命令 → denyTool（exit0 + permissionDecision:deny）----
  // 注：incremental 下 `git add` 后的文件被 git ls-files 视为已跟踪(isNew=false)会被过滤掉，
  // 故用 mode:full 让 pre_commit 对所有暂存 C++ 跑 cpplint，稳定验证 deny 路径。
  if (hasPython) {
    const repo = newRepo('cse-pc-deny-');
    const cfgDir = path.join(repo, '.claude-cpp-style');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({ mode: 'full' }));
    const f = path.join(repo, 'bad.cpp');
    fs.writeFileSync(f, VIOLATION_CPP);  // 暂存、有违规
    sh(['add', 'bad.cpp'], repo);

    const r = runPreCommit(
      { cwd: repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } }, repo);
    assert.strictEqual(r.status, 0, 'pre_commit: denyTool 仍 exit 0');
    const stdout = (r.stdout || '').trim();
    assert.ok(stdout.length > 0, 'pre_commit: 暂存违规必产出 stdout（deny）');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny',
      'pre_commit: 暂存违规 .cpp → permissionDecision:deny');
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.length > 0,
      'pre_commit: deny reason 非空');
  }

  // ---- pre_commit 集成：无暂存 C++ → passSilent（exit0 stdout 空）----
  {
    const repo = newRepo('cse-pc-pass-');
    const txt = path.join(repo, 'readme.txt');
    fs.writeFileSync(txt, 'hello');
    sh(['add', 'readme.txt'], repo);  // 暂存的非 C++ 文件

    const r = runPreCommit(
      { cwd: repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } }, repo);
    assert.strictEqual(r.status, 0, 'pre_commit: 无暂存 C++ exit 0');
    assert.strictEqual((r.stdout || '').trim(), '', 'pre_commit: 无暂存 C++ → passSilent stdout 空');
  }

  // ---- pre_commit 集成：非 commit 命令 → passSilent ----
  {
    const repo = newRepo('cse-pc-nc-');
    const r = runPreCommit(
      { cwd: repo, tool_name: 'Bash', tool_input: { command: 'git status' } }, repo);
    assert.strictEqual(r.status, 0, 'pre_commit: 非 commit exit 0');
    assert.strictEqual((r.stdout || '').trim(), '', 'pre_commit: 非 commit → passSilent stdout 空');
  }

  console.log('integration.test.js PASS');
} finally {
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {}
  }
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch (_) {}
}
