'use strict';

// 集成回归测试（spec §10）：在临时 Git 仓库或无 Git 目录 spawnSync 子进程跑入口脚本，
// 喂 stdin，断言 (exit/stdout/stderr) 固化崩溃修复后的行为契约。
// PostToolUse 延迟记录 + Stop 统一处理场景 a-e + pre_commit denyTool/passSilent。

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolvePython } = require('../lib/python');

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
function newDirectory(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'cse-int-'));
  repos.push(tmp);
  return tmp;
}

function newRepo(prefix) {
  const tmp = newDirectory(prefix);
  sh(['init'], tmp);
  sh(['config', 'user.email', 't@t.com'], tmp);
  sh(['config', 'user.name', 't'], tmp);
  sh(['config', 'commit.gpgsign', 'false'], tmp);
  return tmp;
}

function configureCpplintOnly(root) {
  const cfgDir = path.join(root, '.codex-cpp-style');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({
    checks: { clangFormat: false, copyright: false, cpplint: true, bom: false },
  }));
}

function writeHeader(filePath, guard) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#ifndef ${guard}\n#define ${guard}\n\n#endif  // ${guard}\n`);
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

const hasPython = resolvePython() !== null;

try {
  // ---- 场景 (a)：已跟踪文件保持原始编码、BOM 和正文 ----
  {
    const repo = newRepo('cse-a-');
    const f = path.join(repo, 'old.cpp');
    const originalBytes = Buffer.from('int  old_var( ){return 0;}\n', 'utf8');
    fs.writeFileSync(f, originalBytes);
    sh(['add', 'old.cpp'], repo);
    sh(['commit', '-m', 'init'], repo);

    const { post, stop } = runDeferred({ cwd: repo, tool_name: 'Edit', tool_input: { file_path: f } });
    assert.strictEqual(post.status, 0, '场景a: 老文件编辑 exit 0（不崩溃）');
    assert.strictEqual((post.stdout || '').trim(), '', '场景a: 编辑阶段只记录、不 block');
    assert.strictEqual(stop.status, 0, '场景a: Stop 统一处理 exit 0');
    assert.deepStrictEqual(JSON.parse(stop.stdout), {}, '场景a: 字节未变化时 Stop 静默结束');
    assert.ok(fs.readFileSync(f).equals(originalBytes), '场景a: 老文件编码、BOM 与正文均保持不变');
  }

  // 旧版生成的配置可能仍含 legacyChecks.bom:true，也不得改写已跟踪文件。
  {
    const repo = newRepo('cse-a-legacy-config-');
    const cfgDir = path.join(repo, '.codex-cpp-style');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({
      mode: 'incremental',
      legacyChecks: { bom: true },
    }));
    const f = path.join(repo, 'legacy-config.cpp');
    const originalBytes = Buffer.from('int legacy_config;\n', 'utf8');
    fs.writeFileSync(f, originalBytes);
    sh(['add', 'legacy-config.cpp'], repo);
    sh(['commit', '-m', 'init'], repo);

    const { stop } = runDeferred({ cwd: repo, tool_name: 'Edit', tool_input: { file_path: f } });
    assert.deepStrictEqual(JSON.parse(stop.stdout), {}, '旧版 BOM 配置不得触发老文件改写');
    assert.ok(fs.readFileSync(f).equals(originalBytes), '旧版配置下仍保持原始 BOM 状态');
  }

  // ---- 场景 (c)：与 (a) 同一契约的显式重述（老文件保持原编码）----
  // 已在场景 a 覆盖，不再重复创建仓库。

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

  // 无 Git 项目：真实 Stop 使用任务目录推导稳定 guard，并拒绝机器绝对路径 guard。
  if (hasPython) {
    const workspace = newDirectory('cse-no-git-guard-');
    configureCpplintOnly(workspace);
    const f = path.join(workspace, 'work_cpp_smoke', 'batch_collector.h');
    const guard = 'WORK_CPP_SMOKE_BATCH_COLLECTOR_H_';
    writeHeader(f, guard);
    const originalBytes = fs.readFileSync(f);

    const { post, stop } = runDeferred({ cwd: workspace, tool_name: 'Write', tool_input: { file_path: f } });
    assert.strictEqual(post.status, 0, '无 Git guard: PostToolUse exit 0');
    assert.strictEqual((post.stdout || '').trim(), '', '无 Git guard: 编辑阶段仅记录');
    assert.strictEqual(stop.status, 0, '无 Git guard: Stop exit 0');
    assert.deepStrictEqual(JSON.parse(stop.stdout), {}, '无 Git guard: 项目相对路径 guard 通过');
    assert.ok(fs.readFileSync(f).equals(originalBytes), '无 Git guard: 检查不改写头文件');

    const absoluteGuard = f.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase() + '_';
    writeHeader(f, absoluteGuard);
    const { stop: invalidStop } = runDeferred({
      cwd: workspace, tool_name: 'Edit', tool_input: { file_path: f },
    });
    assert.strictEqual(invalidStop.status, 0, '绝对路径 guard: Stop exit 0');
    const invalid = JSON.parse(invalidStop.stdout);
    assert.strictEqual(invalid.decision, 'block', '绝对路径 guard: 必须拒绝');
    assert.ok(invalid.reason.includes('[build/header_guard]'), '绝对路径 guard: 保留 guard 检查');
    assert.ok(invalid.reason.includes(`please use: ${guard}`), '绝对路径 guard: 提示稳定的项目相对路径宏名');

    // cwd 与文件目录共享名称前缀，但两者互不包含，必须回退到文件所在目录。
    const cwd = path.join(workspace, 'project');
    fs.mkdirSync(cwd);
    const external = path.join(workspace, 'project-other', 'include', 'batch_collector.h');
    writeHeader(external, 'BATCH_COLLECTOR_H_');
    const { stop: externalStop } = runDeferred({
      cwd, tool_name: 'Write', tool_input: { file_path: external },
    });
    assert.strictEqual(externalStop.status, 0, '同名前缀目录: Stop exit 0');
    assert.deepStrictEqual(JSON.parse(externalStop.stdout), {},
      '同名前缀目录: 不把 cwd 当作包含根，使用文件所在目录的 guard');
  }

  // Git 根目录优先于任务 cwd：从子目录编辑头文件仍使用仓库相对路径 guard。
  if (hasPython) {
    const repo = newRepo('cse-git-guard-');
    configureCpplintOnly(repo);
    const f = path.join(repo, 'work_cpp_smoke', 'batch_collector.h');
    writeHeader(f, 'WORK_CPP_SMOKE_BATCH_COLLECTOR_H_');
    const { stop } = runDeferred({
      cwd: path.dirname(f), tool_name: 'Write', tool_input: { file_path: f },
    });
    assert.strictEqual(stop.status, 0, 'Git guard: Stop exit 0');
    assert.deepStrictEqual(JSON.parse(stop.stdout), {}, 'Git guard: 真实 Git 根目录优先于 cwd');
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
