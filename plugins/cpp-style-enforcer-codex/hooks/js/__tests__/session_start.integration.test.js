const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const entry = path.join(pluginRoot, 'hooks', 'js', 'session_start.js');

// 用临时 HOME 隔离全局模板，避免污染真实 ~/.codex
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-home-'));
const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
delete env.PLUGIN_ROOT;
delete env.PLUGIN_DATA;
const userTpl = path.join(tmpHome, '.codex', 'cpp-style-template.json');

const tmps = [];
function runHook(input = { hook_event_name: 'SessionStart' }) {
  const r = spawnSync('node', [entry], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 10000,
    env,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sh(args, cwd) { spawnSync('git', args, { cwd, stdio: 'pipe' }); }
function mkGitRepo() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-repo-'));
  tmps.push(t);
  sh(['init'], t);
  return t;
}
function cfgPath(root) { return path.join(root, '.claude-cpp-style', 'cpp-style.json'); }
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

try {
  // 1) 首次运行 → 创建全局模板，无输出，exit 0
  {
    const r = runHook();
    assert.strictEqual(r.status, 0, 'SessionStart 应 exit 0');
    assert.strictEqual(r.stdout, '', 'SessionStart 应 stdout 空（完全静默）');
    assert.strictEqual(r.stderr, '', 'SessionStart 应 stderr 空（完全静默）');
    assert.ok(fs.existsSync(userTpl), '首次运行应创建全局模板');
  }

  // 2) 已存在用户自填模板 → 绝不覆盖（字节级一致）
  {
    const custom = JSON.stringify({ enabled: true, mode: 'full', copyrightInfo: { company: 'ACME' } });
    fs.writeFileSync(userTpl, custom);
    const before = fs.readFileSync(userTpl);
    const r = runHook();
    assert.strictEqual(r.status, 0, '二次运行应 exit 0');
    const after = fs.readFileSync(userTpl);
    assert.ok(before.equals(after), '已存在模板必须字节级不变（不覆盖用户 company）');
  }

  // 3) cwd 为 C++ git 项目（有 .cpp）→ 提前生成 .claude-cpp-style/cpp-style.json，静默 exit 0
  {
    const root = mkGitRepo();
    fs.writeFileSync(path.join(root, 'main.cpp'), 'int main(){return 0;}\n');
    const r = runHook({ hook_event_name: 'SessionStart', cwd: root });
    assert.strictEqual(r.status, 0, 'C++ 项目 SessionStart 应 exit 0');
    assert.strictEqual(r.stdout, '', 'C++ 项目 SessionStart 应 stdout 空');
    assert.strictEqual(r.stderr, '', 'C++ 项目 SessionStart 应 stderr 空');
    assert.ok(fs.existsSync(cfgPath(root)), 'C++ 项目应提前生成 cpp-style.json');
    const buf = fs.readFileSync(cfgPath(root));
    assert.ok(!buf.subarray(0, 3).equals(BOM), '生成配置无 BOM');
    JSON.parse(buf.toString('utf-8')); // 合法 JSON
  }

  // 4) 已存在 cpp-style.json → 不覆盖（字节不变）
  {
    const root = mkGitRepo();
    fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(x)\n');
    const dir = path.join(root, '.claude-cpp-style');
    fs.mkdirSync(dir, { recursive: true });
    const custom = Buffer.from('{"enabled":false,"mode":"full"}\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'cpp-style.json'), custom);
    const r = runHook({ hook_event_name: 'SessionStart', cwd: root });
    assert.strictEqual(r.status, 0, '已存在配置 SessionStart 应 exit 0');
    assert.ok(fs.readFileSync(cfgPath(root)).equals(custom), '已存在配置必须字节不变（不覆盖）');
  }

  // 5) 非 git 目录 → 不生成
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-nogit-'));
    tmps.push(t);
    fs.writeFileSync(path.join(t, 'main.cpp'), 'int main(){}\n');
    const r = runHook({ hook_event_name: 'SessionStart', cwd: t });
    assert.strictEqual(r.status, 0, '非 git SessionStart 应 exit 0');
    assert.ok(!fs.existsSync(cfgPath(t)), '非 git 不生成配置（无可靠项目根）');
  }

  // 6) git 仓库但非 C++ 项目（纯 python/js）→ 不生成（保守判断）
  {
    const root = mkGitRepo();
    fs.writeFileSync(path.join(root, 'app.py'), 'print(1)\n');
    fs.writeFileSync(path.join(root, 'index.js'), 'console.log(1)\n');
    const r = runHook({ hook_event_name: 'SessionStart', cwd: root });
    assert.strictEqual(r.status, 0, '非 C++ 项目 SessionStart 应 exit 0');
    assert.strictEqual(r.stdout, '', '非 C++ 项目应静默');
    assert.ok(!fs.existsSync(cfgPath(root)), '非 C++ 项目不生成配置（保守）');
  }

  console.log('session_start.integration.test.js PASS');
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  for (const t of tmps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch (_) {} }
}
