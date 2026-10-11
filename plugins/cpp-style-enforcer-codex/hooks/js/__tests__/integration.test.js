'use strict';

// Integration regression (spec section 10): spawn entry scripts in temporary Git or non-Git directories,
// feed stdin, and assert exit/stdout/stderr to preserve the post-crash behavior contract.
// Cover deferred PostToolUse records, Stop scenarios a-e, and pre_commit denyTool/passSilent.

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

// Isolate HOME to avoid the real global template and use hard-coded incremental defaults.
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
  // ---- Scenario (a):Tracked files retain original encoding, BOM, and body. ----
  {
    const repo = newRepo('cse-a-');
    const f = path.join(repo, 'old.cpp');
    const originalBytes = Buffer.from('int  old_var( ){return 0;}\n', 'utf8');
    fs.writeFileSync(f, originalBytes);
    sh(['add', 'old.cpp'], repo);
    sh(['commit', '-m', 'init'], repo);

    const { post, stop } = runDeferred({ cwd: repo, tool_name: 'Edit', tool_input: { file_path: f } });
    assert.strictEqual(post.status, 0, 'Scenario a: editing a tracked file exits 0');
    assert.strictEqual((post.stdout || '').trim(), '', 'Scenario a: edit phase records without blocking');
    assert.strictEqual(stop.status, 0, 'Scenario a: Stop batch processing exits 0');
    assert.deepStrictEqual(JSON.parse(stop.stdout), {}, 'Scenario a: Stop finishes silently when bytes stay unchanged');
    assert.ok(fs.readFileSync(f).equals(originalBytes), 'Scenario a: tracked-file encoding, BOM, and body stay unchanged');
  }

  // A legacy config may retain legacyChecks.bom:true; tracked files still must not be rewritten.
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
    assert.deepStrictEqual(JSON.parse(stop.stdout), {}, 'Legacy BOM settings must not rewrite tracked files');
    assert.ok(fs.readFileSync(f).equals(originalBytes), 'Legacy settings still preserve original BOM state');
  }

  // ---- Scenario (c):Restate contract (a): tracked files retain encoding.----
  // Scenario (a) covers this without creating another repository.

  // ---- Scenario (d):enabled:false is a complete no-op (exit 0, no output, no byte changes).----
  {
    const repo = newRepo('cse-d-');
    const cfgDir = path.join(repo, '.claude-cpp-style');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({ enabled: false }));
    const f = path.join(repo, 'noop.cpp');
    // A messy new file without BOM must remain byte-identical when disabled.
    fs.writeFileSync(f, 'int  main( ){int x=1;return x;}\n');
    const before = fs.readFileSync(f);

    const { post, stop } = runDeferred({ cwd: repo, tool_name: 'Write', tool_input: { file_path: f } });
    assert.strictEqual(post.status, 0, 'Scenariod: enabled:false exit 0');
    assert.strictEqual((post.stdout || '').trim(), '', 'Scenario d: empty stdout during editing');
    assert.deepStrictEqual(JSON.parse(stop.stdout), {}, 'Scenariod: Stop no-op');
    assert.ok(fs.readFileSync(f).equals(before), 'Scenario d: disabled file stays byte-identical');
  }

  // ---- Scenario (e):Bash input without file_path passes silently; also verify no child Node chain.----
  {
    const repo = newRepo('cse-e-');
    const start = Date.now();
    const r = runPost({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'echo "edit a.cpp"' } });
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0, 'Scenario e: incidental Bash input exits 0');
    assert.strictEqual((r.stdout || '').trim(), '', 'Scenario e: no file_path passes silently');
    // One process may spawn Git, Python, or clang-format, but no child Node; total runtime stays bounded.
    assert.ok(elapsed < 30000, 'Scenario e: single-process pipeline finishes within 30 s');
  }
  // Static check: post_edit.js does not spawn a child Node process.
  {
    const srcPost = fs.readFileSync(postEdit, 'utf-8');
    assert.ok(!/spawn[A-Za-z]*\(\s*['"]node['"]/.test(srcPost),
      'Scenario e: post_edit.js spawns no child Node process');
  }

  // A C-style cast triggers cpplint readability/casting; clang-format does not repair it,
  // so the full pipeline still reports it and must block or deny.
  // Long lines or tight braces are unsuitable because clang-format would fix them.
  const VIOLATION_CPP = 'int main() {\n  double d = 3.5;\n  int y = (int)d;\n  return y;\n}\n';

  // ---- Scenario (b):New file with cpplint violation: exit 0 and decision:block JSON (requires Python/cpplint).----
  if (hasPython) {
    const repo = newRepo('cse-b-');
    const f = path.join(repo, 'new.cpp');
    // Untracked new file uses the full incremental workflow.
    fs.writeFileSync(f, VIOLATION_CPP);

    const { post, stop } = runDeferred({ cwd: repo, tool_name: 'Write', tool_input: { file_path: f } });
    assert.strictEqual(post.status, 0, 'Scenario b: edit phase exits 0');
    assert.strictEqual((post.stdout || '').trim(), '', 'Scenario b: edit phase neither checks nor blocks');
    assert.strictEqual(stop.status, 0, 'Scenario b: Stop check exits 0, never 2');
    const stdout = (stop.stdout || '').trim();
    assert.ok(stdout.length > 0, 'Scenario b: Stop emits block output on violations');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'Scenario b: violating new file emits decision:block JSON');
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0, 'Scenario b: reason is nonempty');
    assert.ok(/casting/.test(parsed.reason), 'Scenario b: reason includes readability/casting');
  }

  // Without Git, real Stop derives a stable guard from the task directory, excluding machine paths.
  if (hasPython) {
    const workspace = newDirectory('cse-no-git-guard-');
    configureCpplintOnly(workspace);
    const f = path.join(workspace, 'work_cpp_smoke', 'batch_collector.h');
    const guard = 'WORK_CPP_SMOKE_BATCH_COLLECTOR_H_';
    writeHeader(f, guard);
    const originalBytes = fs.readFileSync(f);

    const { post, stop } = runDeferred({ cwd: workspace, tool_name: 'Write', tool_input: { file_path: f } });
    assert.strictEqual(post.status, 0, 'Non-Git guard: PostToolUse exits 0');
    assert.strictEqual((post.stdout || '').trim(), '', 'Non-Git guard: edit phase only records');
    assert.strictEqual(stop.status, 0, 'Non-Git guard: Stop exits 0');
    assert.deepStrictEqual(JSON.parse(stop.stdout), {}, 'Non-Git guard: project-relative guard passes');
    assert.ok(fs.readFileSync(f).equals(originalBytes), 'Non-Git guard: check does not rewrite header');

    const absoluteGuard = f.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase() + '_';
    writeHeader(f, absoluteGuard);
    const { stop: invalidStop } = runDeferred({
      cwd: workspace, tool_name: 'Edit', tool_input: { file_path: f },
    });
    assert.strictEqual(invalidStop.status, 0, 'Absolute-path guard: Stop exits 0');
    const invalid = JSON.parse(invalidStop.stdout);
    assert.strictEqual(invalid.decision, 'block', 'Absolute-path guard: must reject');
    assert.ok(invalid.reason.includes('[build/header_guard]'), 'Absolute-path guard: guard check remains active');
    assert.ok(invalid.reason.includes(`please use: ${guard}`), 'Absolute-path guard: suggest stable project-relative macro');

    // If cwd and the file directory share only a name prefix, fall back to the actual file directory.
    const cwd = path.join(workspace, 'project');
    fs.mkdirSync(cwd);
    const external = path.join(workspace, 'project-other', 'include', 'batch_collector.h');
    writeHeader(external, 'BATCH_COLLECTOR_H_');
    const { stop: externalStop } = runDeferred({
      cwd, tool_name: 'Write', tool_input: { file_path: external },
    });
    assert.strictEqual(externalStop.status, 0, 'Name-prefix sibling: Stop exits 0');
    assert.deepStrictEqual(JSON.parse(externalStop.stdout), {},
      'Name-prefix sibling: use the file directory guard instead of cwd');
  }

  // Git root outranks task cwd; editing a header in a subdirectory still uses a repository-relative guard.
  if (hasPython) {
    const repo = newRepo('cse-git-guard-');
    configureCpplintOnly(repo);
    const f = path.join(repo, 'work_cpp_smoke', 'batch_collector.h');
    writeHeader(f, 'WORK_CPP_SMOKE_BATCH_COLLECTOR_H_');
    const { stop } = runDeferred({
      cwd: path.dirname(f), tool_name: 'Write', tool_input: { file_path: f },
    });
    assert.strictEqual(stop.status, 0, 'Git guard: Stop exit 0');
    assert.deepStrictEqual(JSON.parse(stop.stdout), {}, 'Git guard: real Git root takes precedence over cwd');
  }

  // ---- pre_commit integration:Staged violating .cpp with real git commit: denyTool (exit 0, permissionDecision: deny).----
  // In incremental mode, git ls-files treats added files as tracked (isNew=false), so they are filtered;
  // use mode:full to lint all staged C++ files and reliably verify denial.
  if (hasPython) {
    const repo = newRepo('cse-pc-deny-');
    const cfgDir = path.join(repo, '.claude-cpp-style');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({ mode: 'full' }));
    const f = path.join(repo, 'bad.cpp');
    fs.writeFileSync(f, VIOLATION_CPP);  // Staged and violating.
    sh(['add', 'bad.cpp'], repo);

    const r = runPreCommit(
      { cwd: repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } }, repo);
    assert.strictEqual(r.status, 0, 'pre_commit: denyTool still exits 0');
    const stdout = (r.stdout || '').trim();
    assert.ok(stdout.length > 0, 'pre_commit: staged violations emit deny output');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny',
      'pre_commit: staged violating .cpp yields permissionDecision:deny');
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.length > 0,
      'pre_commit: deny reason is nonempty');
  }

  // ---- pre_commit integration:No staged C++: passSilent with exit 0 and empty stdout.----
  {
    const repo = newRepo('cse-pc-pass-');
    const txt = path.join(repo, 'readme.txt');
    fs.writeFileSync(txt, 'hello');
    sh(['add', 'readme.txt'], repo);  // Staged non-C++ file.

    const r = runPreCommit(
      { cwd: repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } }, repo);
    assert.strictEqual(r.status, 0, 'pre_commit: no staged C++ exits 0');
    assert.strictEqual((r.stdout || '').trim(), '', 'pre_commit: no staged C++ passes silently');
  }

  // ---- pre_commit integration:Non-commit command: passSilent. ----
  {
    const repo = newRepo('cse-pc-nc-');
    const r = runPreCommit(
      { cwd: repo, tool_name: 'Bash', tool_input: { command: 'git status' } }, repo);
    assert.strictEqual(r.status, 0, 'pre_commit: non-commit exits 0');
    assert.strictEqual((r.stdout || '').trim(), '', 'pre_commit: non-commit passes silently');
  }

  console.log('integration.test.js PASS');
} finally {
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {}
  }
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch (_) {}
}
