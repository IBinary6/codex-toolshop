const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { recordPendingPaths } = require('../lib/pending_edits');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const runner = path.join(pluginRoot, 'scripts', 'run-hook.cjs');

function runHook(name, input, cwd, dataDir, env = {}) {
  const result = spawnSync(process.execPath, [runner, name], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: dataDir, ...env },
    windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stderr, '');
  return (result.stdout || '').trim();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-style-deferred-'));
try {
  const dataDir = path.join(tmp, 'data');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, '.codex-cpp-style'), { recursive: true });
  fs.writeFileSync(path.join(project, '.codex-cpp-style', 'cpp-style.json'), JSON.stringify({
    enabled: true,
    mode: 'full',
    checks: { clangFormat: false, copyright: false, cpplint: false, bom: true },
  }));

  const source = path.join(project, 'main.cpp');
  fs.writeFileSync(source, 'int main() { return 0; }\n', 'utf8');
  const hookInput = {
    session_id: 'session-a',
    turn_id: 'turn-a',
    cwd: project,
    tool_name: 'apply_patch',
    tool_use_id: 'tool-a',
    tool_input: { file_path: source },
  };

  const postOutput = runHook('post_edit', hookInput, project, dataDir);
  assert.strictEqual(postOutput, '', 'A successful automatic repair is silent');
  assert.ok(fs.readFileSync(source).subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])),
    'The source is already repaired before the model resumes');
  const checked = fs.readFileSync(source);

  const stopOutput = runHook('stop_check', {
    session_id: 'session-a',
    turn_id: 'turn-a',
    cwd: project,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  }, project, dataDir);
  assert.deepStrictEqual(fs.readFileSync(source), checked);
  assert.strictEqual(stopOutput, '', 'Stop is silent');

  const secondStop = runHook('stop_check', {
    session_id: 'session-a',
    turn_id: 'turn-a',
    cwd: project,
    hook_event_name: 'Stop',
    stop_hook_active: true,
  }, project, dataDir);
  assert.strictEqual(secondStop, '');

  const legacy = path.join(project, 'legacy.cpp');
  fs.writeFileSync(legacy, 'int old_value;');
  process.env.PLUGIN_DATA = dataDir;
  assert.ok(recordPendingPaths(hookInput, [legacy]));
  assert.strictEqual(runHook('stop_check', hookInput, project, dataDir), '');
  assert.strictEqual(fs.readFileSync(legacy, 'utf8'), 'int old_value;', 'Stop does not change a pending legacy file');
  assert.strictEqual(runHook('post_edit', hookInput, project, dataDir), '');
  assert.ok(fs.readFileSync(legacy, 'utf8').endsWith('\n'), 'PostToolUse drains same-turn legacy edits');
  fs.writeFileSync(legacy, 'int old_value;');
  assert.strictEqual(runHook('post_edit', hookInput, project, dataDir), '');
  assert.strictEqual(fs.readFileSync(legacy, 'utf8'), 'int old_value;', 'Completed legacy records are consumed');

  fs.writeFileSync(path.join(project, '.codex-cpp-style', 'cpp-style.json'), JSON.stringify({
    mode: 'full', checks: { clangFormat: false, copyright: false, cpplint: true, bom: false },
  }));
  const missingPython = JSON.parse(runHook('post_edit', hookInput, project, dataDir, {
    CPP_STYLE_PYTHON: path.join(tmp, 'missing-python'),
  }));
  assert.deepStrictEqual(Object.keys(missingPython), ['hookSpecificOutput']);
  assert.match(missingPython.hookSpecificOutput.additionalContext, /runtime\/cpplint.*check not run/);
  assert.match(fs.readFileSync(path.join(dataDir, 'latest-diagnostic.json'), 'utf8'), /check not run/);

  fs.writeFileSync(source, 'int main() { double value = 1.5; return (int)value; }\n');
  const bad = JSON.parse(runHook('post_edit', hookInput, project, dataDir));
  assert.match(bad.hookSpecificOutput.additionalContext, /readability\/casting/);
  fs.writeFileSync(source, 'int main() { return 0; }\n');
  assert.strictEqual(runHook('post_edit', hookInput, project, dataDir), '', 'A fixed edit does not repeat old findings');

  const unwritableData = path.join(tmp, 'data-is-file');
  fs.writeFileSync(unwritableData, '');
  fs.writeFileSync(source, 'int main() { return 0; }');
  assert.strictEqual(runHook('post_edit', hookInput, project, unwritableData), '');
  assert.ok(fs.readFileSync(source, 'utf8').endsWith('\n'), 'Actual edits are still checked and repaired when data is unavailable');

  console.log('deferred_style.integration.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
