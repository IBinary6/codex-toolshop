const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const entry = path.join(pluginRoot, 'hooks', 'js', 'session_start.js');

// Use temporary HOME to isolate the global template from real ~/.codex.
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
function cfgPath(root) { return path.join(root, '.codex-cpp-style', 'cpp-style.json'); }
function legacyCfgPath(root) { return path.join(root, '.claude-cpp-style', 'cpp-style.json'); }

try {
  // 1) First run creates the global template with no output and exit 0.
  {
    const r = runHook();
    assert.strictEqual(r.status, 0, 'SessionStart exits 0');
    assert.strictEqual(r.stdout, '', 'SessionStart leaves stdout empty');
    assert.strictEqual(r.stderr, '', 'SessionStart leaves stderr empty');
    assert.ok(fs.existsSync(userTpl), 'First run creates the global template');
  }

  // 2) Existing user-filled template is never overwritten (byte-identical).
  {
    const custom = JSON.stringify({ enabled: true, mode: 'full', copyrightInfo: { company: 'ACME' } });
    fs.writeFileSync(userTpl, custom);
    const before = fs.readFileSync(userTpl);
    const r = runHook();
    assert.strictEqual(r.status, 0, 'Second run exits 0');
    const after = fs.readFileSync(userTpl);
    assert.ok(before.equals(after), 'Existing template remains byte-for-byte unchanged, preserving the user company');
  }

  // 3) Opening a C++ project without an edit does not generate project configuration.
  {
    const root = mkGitRepo();
    fs.writeFileSync(path.join(root, 'main.cpp'), 'int main(){return 0;}\n');
    const r = runHook({ hook_event_name: 'SessionStart', cwd: root });
    assert.strictEqual(r.status, 0, 'SessionStart exits 0 for a C++ project');
    assert.strictEqual(r.stdout, '', 'SessionStart leaves stdout empty for a C++ project');
    assert.strictEqual(r.stderr, '', 'SessionStart leaves stderr empty for a C++ project');
    assert.ok(!fs.existsSync(cfgPath(root)), 'SessionStart does not write to the project under review');
    assert.ok(!fs.existsSync(path.join(root, '.clang-format')), 'SessionStart does not write formatting configuration');
  }

  // 4) Existing cpp-style.json is not overwritten (byte-identical).
  {
    const root = mkGitRepo();
    fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(x)\n');
    const dir = path.join(root, '.codex-cpp-style');
    fs.mkdirSync(dir, { recursive: true });
    const custom = Buffer.from('{"enabled":false,"mode":"full"}\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'cpp-style.json'), custom);
    const r = runHook({ hook_event_name: 'SessionStart', cwd: root });
    assert.strictEqual(r.status, 0, 'SessionStart exits 0 with existing configuration');
    assert.ok(fs.readFileSync(cfgPath(root)).equals(custom), 'Existing configuration remains byte-for-byte unchanged');
  }

  // 5) Legacy Claude path remains valid without generating another path.
  {
    const root = mkGitRepo();
    fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(x)\n');
    const dir = path.join(root, '.claude-cpp-style');
    fs.mkdirSync(dir, { recursive: true });
    const custom = Buffer.from('{"enabled":false}\n', 'utf-8');
    fs.writeFileSync(legacyCfgPath(root), custom);
    const r = runHook({ hook_event_name: 'SessionStart', cwd: root });
    assert.strictEqual(r.status, 0, 'SessionStart exits 0 with legacy-path configuration');
    assert.ok(!fs.existsSync(cfgPath(root)), 'A legacy path prevents duplicate configuration at the new path');
    assert.ok(fs.readFileSync(legacyCfgPath(root)).equals(custom), 'Legacy-path configuration is preserved');
  }

  // 6) Outside Git: do not generate.
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-nogit-'));
    tmps.push(t);
    fs.writeFileSync(path.join(t, 'main.cpp'), 'int main(){}\n');
    const r = runHook({ hook_event_name: 'SessionStart', cwd: t });
    assert.strictEqual(r.status, 0, 'SessionStart exits 0 outside Git');
    assert.ok(!fs.existsSync(cfgPath(t)), 'No configuration is generated outside Git without a reliable project root');
  }

  // 7) Non-C++ Git repository (only Python/JS): do not generate.
  {
    const root = mkGitRepo();
    fs.writeFileSync(path.join(root, 'app.py'), 'print(1)\n');
    fs.writeFileSync(path.join(root, 'index.js'), 'console.log(1)\n');
    const r = runHook({ hook_event_name: 'SessionStart', cwd: root });
    assert.strictEqual(r.status, 0, 'SessionStart exits 0 outside a C++ project');
    assert.strictEqual(r.stdout, '', 'Non-C++ project remains silent');
    assert.ok(!fs.existsSync(cfgPath(root)), 'Non-C++ project does not generate configuration');
  }

  console.log('session_start.integration.test.js PASS');
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  for (const t of tmps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch (_) {} }
}
