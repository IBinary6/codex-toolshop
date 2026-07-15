const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const runner = path.join(pluginRoot, 'scripts', 'run-hook.cjs');

function runHook(name, input, cwd, dataDir) {
  const result = spawnSync(process.execPath, [runner, name], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: dataDir },
    windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(result.status, 0, result.stderr);
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
  assert.strictEqual(postOutput, '', '编辑后只记录文件，不向 Codex 注入额外输出');
  assert.ok(!fs.readFileSync(source).subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])),
    'PostToolUse 不应立即改写文件');

  const stopOutput = runHook('stop_check', {
    session_id: 'session-a',
    turn_id: 'turn-a',
    cwd: project,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  }, project, dataDir);
  assert.ok(fs.readFileSync(source).subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])),
    'Stop 时统一补齐 BOM');
  const payload = JSON.parse(stopOutput);
  assert.strictEqual(payload.decision, 'block', '统一修复后让 Codex 继续做最终验证');

  const secondStop = runHook('stop_check', {
    session_id: 'session-a',
    turn_id: 'turn-a',
    cwd: project,
    hook_event_name: 'Stop',
    stop_hook_active: true,
  }, project, dataDir);
  assert.deepStrictEqual(JSON.parse(secondStop), {}, '没有待处理文件时允许本轮结束');

  console.log('deferred_style.integration.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
