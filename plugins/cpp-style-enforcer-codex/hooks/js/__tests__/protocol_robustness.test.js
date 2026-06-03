'use strict';

// Hook 协议健壮性测试（官方协议缺口）：
//   缺口A 畸形 stdin 不崩 —— post_edit.js / pre_commit.js 喂各类畸形输入都 exit 0、不崩。
//   缺口B stdout 纯净性 —— block 场景 stdout trim 后是单个合法 JSON，无诊断文本混入。
//   缺口C block 路径不依赖 if(hasPython) 旁路 —— 本机有 python 则强制断言 block 必触发。
//
// 注：本测试的缺口B/C 需要 python（仓库自带 hooks/js/cpplint/cpplint.py，无需 pip 安装 cpplint）。
//     缺口A 不依赖任何外部工具。

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const postEdit = path.join(__dirname, '..', 'post_edit.js');
const preCommit = path.join(__dirname, '..', 'pre_commit.js');

function sh(args, cwd) { spawnSync('git', args, { cwd, stdio: 'pipe' }); }

// 隔离 HOME，避免读到真实全局模板
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-rbhome-'));
const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };

const repos = [];
function newRepo(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'cse-rb-'));
  repos.push(tmp);
  sh(['init'], tmp);
  sh(['config', 'user.email', 't@t.com'], tmp);
  sh(['config', 'user.name', 't'], tmp);
  sh(['config', 'commit.gpgsign', 'false'], tmp);
  return tmp;
}

// 直接用原始字符串喂 stdin（而非 JSON.stringify），以构造畸形输入
function runRaw(entry, rawInput, cwd) {
  const r = spawnSync('node', [entry], {
    input: rawInput, encoding: 'utf-8', timeout: 30000, env, cwd,
  });
  return { status: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
}

const hasPython = spawnSync('python', ['--version'], { stdio: 'pipe' }).status === 0
  || spawnSync('python3', ['--version'], { stdio: 'pipe' }).status === 0;

// 合法输出契约：要么空，要么 trim 后是单个合法 JSON
function assertCleanStdout(stdout, ctx) {
  const t = stdout.trim();
  if (t === '') return;
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(t); },
    `${ctx}: stdout 非空时必须是合法 JSON（trim 后），实际=${JSON.stringify(stdout)}`);
  // 整个 stdout trim 后就是那个 JSON，重新序列化能 round-trip（无多余日志行混入）
  assert.strictEqual(t, JSON.stringify(parsed), `${ctx}: stdout 必须正好是单个 JSON，无多余文本`);
}

try {
  // ====== 缺口A：post_edit.js 畸形 stdin 不崩 ======
  const repoA = newRepo('cse-rb-a-');
  const malformedInputs = [
    ['非法 JSON', '{bad json'],
    ['空 stdin', ''],
    ['缺 tool_input 字段', '{"tool_name":"Write"}'],
    ['tool_input 不含 file_path', '{"tool_name":"Write","tool_input":{}}'],
    ['file_path 指向不存在的文件',
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(repoA, 'ghost.cpp') } })],
  ];
  for (const [name, raw] of malformedInputs) {
    const r = runRaw(postEdit, raw, repoA);
    assert.strictEqual(r.status, 0, `post_edit 畸形输入[${name}]: 必 exit 0 不崩（实际 status=${r.status}, stderr=${r.stderr}）`);
    assertCleanStdout(r.stdout, `post_edit 畸形输入[${name}]`);
  }

  // ====== 缺口A：pre_commit.js 畸形 stdin / 缺 command ======
  const repoPC = newRepo('cse-rb-pc-');
  const preMalformed = [
    ['非法 JSON', '{bad json'],
    ['空 stdin', ''],
    ['缺 command 字段', '{"tool_name":"Bash","tool_input":{}}'],
    ['缺 tool_input 字段', '{"tool_name":"Bash"}'],
  ];
  for (const [name, raw] of preMalformed) {
    const r = runRaw(preCommit, raw, repoPC);
    assert.strictEqual(r.status, 0, `pre_commit 畸形输入[${name}]: 必 exit 0 不崩（实际 status=${r.status}, stderr=${r.stderr}）`);
    assertCleanStdout(r.stdout, `pre_commit 畸形输入[${name}]`);
  }

  // C-style cast：clang-format 不会修复，走完整流水线后 cpplint 必报 readability/casting。
  const VIOLATION_CPP = 'int main() {\n  double d = 3.5;\n  int y = (int)d;\n  return y;\n}\n';

  // ====== 缺口B + 缺口C：block 路径强制断言（本机有 python 则不旁路）======
  // 缺口C 方案：采用「有 python 则强制断言」。本机确认有 python 3.x + 仓库自带 cpplint.py，
  // 故无 python 时直接判定测试环境不达标（报错而非静默跳过），让 block 路径必被验证。
  assert.ok(hasPython,
    '缺口C: 本测试需要 python + 自带 cpplint.py；当前环境无 python，无法验证 block 路径');

  // post_edit block：新文件 + cpplint 违规 → exit0 + stdout 纯净 decision:block JSON
  {
    const repo = newRepo('cse-rb-block-');
    const f = path.join(repo, 'new.cpp');
    fs.writeFileSync(f, VIOLATION_CPP);  // 未跟踪新文件 → 走全套流水线
    const r = runRaw(postEdit,
      JSON.stringify({ cwd: repo, tool_name: 'Write', tool_input: { file_path: f } }), repo);
    assert.strictEqual(r.status, 0, 'block: post_edit 违规仍 exit 0（绝不 exit 2）');
    const t = r.stdout.trim();
    assert.ok(t.length > 0, 'block: 违规必产出 stdout');
    // 缺口B：stdout trim 后是单个合法 JSON，且不含诊断文本
    assertCleanStdout(r.stdout, 'block post_edit');
    const parsed = JSON.parse(t);
    assert.strictEqual(parsed.decision, 'block', 'block: decision:block');
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0, 'block: reason 非空');
  }

  // pre_commit deny：暂存违规 .cpp + 真 commit（mode:full）→ exit0 + stdout 纯净 deny JSON
  {
    const repo = newRepo('cse-rb-deny-');
    const cfgDir = path.join(repo, '.claude-cpp-style');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({ mode: 'full' }));
    const f = path.join(repo, 'bad.cpp');
    fs.writeFileSync(f, VIOLATION_CPP);
    sh(['add', 'bad.cpp'], repo);
    const r = runRaw(preCommit,
      JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } }), repo);
    assert.strictEqual(r.status, 0, 'deny: pre_commit 仍 exit 0');
    const t = r.stdout.trim();
    assert.ok(t.length > 0, 'deny: 暂存违规必产出 stdout');
    // 缺口B：stdout 纯净性
    assertCleanStdout(r.stdout, 'deny pre_commit');
    const parsed = JSON.parse(t);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny', 'deny: permissionDecision:deny');
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.length > 0, 'deny: reason 非空');
  }

  console.log('protocol_robustness.test.js PASS');
} finally {
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {}
  }
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch (_) {}
}
