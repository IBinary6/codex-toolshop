'use strict';

// Hook protocol robustness tests for gaps in the official contract:
//   Gap A: malformed stdin must not crash post_edit.js or pre_commit.js; both exit 0.
//   Gap B: Stop block stdout trims to one valid JSON object without diagnostics.
//   Gap C: block is mandatory with Python available, without an if(hasPython) bypass.
//
// Gaps B and C require Python; cpplint.py is bundled, so no pip install is needed.
//     Gap A requires no external tools.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolvePython } = require('../lib/python');

const postEdit = path.join(__dirname, '..', 'post_edit.js');
const stopCheck = path.join(__dirname, '..', 'stop_check.js');
const preCommit = path.join(__dirname, '..', 'pre_commit.js');

function sh(args, cwd) { spawnSync('git', args, { cwd, stdio: 'pipe' }); }

// Isolate HOME to avoid reading the real global template.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-rbhome-'));
const env = {
  ...process.env,
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  PLUGIN_DATA: path.join(fakeHome, 'plugin-data'),
};

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

// Feed raw strings to stdin rather than JSON.stringify to construct malformed input.
function runRaw(entry, rawInput, cwd) {
  const r = spawnSync('node', [entry], {
    input: rawInput, encoding: 'utf-8', timeout: 30000, env, cwd,
  });
  return { status: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
}

const hasPython = resolvePython() !== null;

// Valid output is empty or one valid JSON value after trimming.
function assertCleanStdout(stdout, ctx) {
  const t = stdout.trim();
  if (t === '') return;
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(t); },
    `${ctx}: nonempty stdout must be valid JSON after trimming; actual=${JSON.stringify(stdout)}`);
  // All trimmed stdout is that JSON and round-trips without extra log lines.
  assert.strictEqual(t, JSON.stringify(parsed), `${ctx}: stdout must contain exactly one JSON value with no extra text`);
}

try {
  // ====== Gap A: malformed stdin does not crash post_edit.js. ======
  const repoA = newRepo('cse-rb-a-');
  const malformedInputs = [
    ['invalid JSON', '{bad json'],
    ['empty stdin', ''],
    ['missing tool_input field', '{"tool_name":"Write"}'],
    ['tool_input without file_path', '{"tool_name":"Write","tool_input":{}}'],
    ['file_path points to a nonexistent file',
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(repoA, 'ghost.cpp') } })],
  ];
  for (const [name, raw] of malformedInputs) {
    const r = runRaw(postEdit, raw, repoA);
    assert.strictEqual(r.status, 0, `post_edit malformed input [${name}]: must exit 0 without crashing (actual status=${r.status}, stderr=${r.stderr})`);
    assertCleanStdout(r.stdout, `post_edit malformed input [${name}]`);
  }

  // ====== Gap A: malformed stdin or missing command in pre_commit.js. ======
  const repoPC = newRepo('cse-rb-pc-');
  const preMalformed = [
    ['invalid JSON', '{bad json'],
    ['empty stdin', ''],
    ['missing command field', '{"tool_name":"Bash","tool_input":{}}'],
    ['missing tool_input field', '{"tool_name":"Bash"}'],
  ];
  for (const [name, raw] of preMalformed) {
    const r = runRaw(preCommit, raw, repoPC);
    assert.strictEqual(r.status, 0, `pre_commit malformed input [${name}]: must exit 0 without crashing (actual status=${r.status}, stderr=${r.stderr})`);
    assertCleanStdout(r.stdout, `pre_commit malformed input [${name}]`);
  }

  // A C-style cast survives clang-format, so cpplint must report readability/casting after the full pipeline.
  const VIOLATION_CPP = 'int main() {\n  double d = 3.5;\n  int y = (int)d;\n  return y;\n}\n';

  // ====== Gaps B and C: assert block without bypass when Python is available.======
  // For Gap C, require Python 3.x and bundled cpplint.py, then assert block unconditionally;
  // if Python is absent, fail the test environment rather than silently skip the block path.
  assert.ok(hasPython,
    'Coverage gap C: this test requires Python and the bundled cpplint.py; without Python the block path cannot be verified');

  // PostToolUse only records; Stop lints a new file and emits clean decision:block JSON.
  {
    const repo = newRepo('cse-rb-block-');
    const f = path.join(repo, 'new.cpp');
    fs.writeFileSync(f, VIOLATION_CPP);  // A new untracked file runs through the full pipeline.
    const hookInput = {
      session_id: 'robust-session',
      turn_id: 'robust-turn',
      tool_use_id: 'robust-tool',
      cwd: repo,
      tool_name: 'Write',
      tool_input: { file_path: f },
    };
    const post = runRaw(postEdit, JSON.stringify(hookInput), repo);
    assert.strictEqual(post.status, 0, 'block: post_edit recording still exits 0');
    assert.strictEqual(post.stdout.trim(), '', 'block: post_edit does not check early');
    const r = runRaw(stopCheck, JSON.stringify({
      session_id: hookInput.session_id,
      turn_id: hookInput.turn_id,
      cwd: repo,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }), repo);
    assert.strictEqual(r.status, 0, 'block: Stop exits 0 even on a violation, never 2');
    const t = r.stdout.trim();
    assert.ok(t.length > 0, 'block: violations produce stdout');
    // Gap B: trimmed stdout is one valid JSON object with no diagnostics.
    assertCleanStdout(r.stdout, 'block stop_check');
    const parsed = JSON.parse(t);
    assert.strictEqual(parsed.decision, 'block', 'block: decision:block');
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0, 'block: reason is nonempty');
  }

  // pre_commit denial: violating staged .cpp plus real commit in full mode yields clean deny JSON and exit 0.
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
    assert.strictEqual(r.status, 0, 'deny: pre_commit still exits 0');
    const t = r.stdout.trim();
    assert.ok(t.length > 0, 'deny: staged violations produce stdout');
    // Gap B: stdout purity.
    assertCleanStdout(r.stdout, 'deny pre_commit');
    const parsed = JSON.parse(t);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny', 'deny: permissionDecision:deny');
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.length > 0, 'deny: reason is nonempty');
  }

  console.log('protocol_robustness.test.js PASS');
} finally {
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {}
  }
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch (_) {}
}
