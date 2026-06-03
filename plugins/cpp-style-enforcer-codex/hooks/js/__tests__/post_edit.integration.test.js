const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const entry = path.join(pluginRoot, 'hooks', 'js', 'post_edit.js');

function runHook(input) {
  const r = spawnSync('node', [entry], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 30000,
  });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' };
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cse-pe-'));
}

// 1) Bash 含 .cpp 字样但无 file_path → passSilent（exit 0，stdout 空）
{
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'echo build main.cpp' } });
  assert.strictEqual(r.status, 0, 'Bash 无 file_path 应 exit 0');
  assert.strictEqual(r.stdout, '', 'Bash 应 stdout 空');
}

// 2) 文件不存在 → passSilent
{
  const r = runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(mkTmpDir(), 'nope.cpp') } });
  assert.strictEqual(r.status, 0, '文件不存在应 exit 0');
  assert.strictEqual(r.stdout, '', '文件不存在应 stdout 空');
}

// 3) 非 C++ 文件 → passSilent
{
  const dir = mkTmpDir();
  const f = path.join(dir, 'readme.txt');
  fs.writeFileSync(f, 'hello');
  const r = runHook({ tool_name: 'Edit', tool_input: { file_path: f } });
  assert.strictEqual(r.status, 0, '非 C++ 应 exit 0');
  assert.strictEqual(r.stdout, '', '非 C++ 应 stdout 空');
}

// 4) enabled:false 项目 → no-op（即便有违规也不 block）
{
  const dir = mkTmpDir();
  fs.mkdirSync(path.join(dir, '.claude-cpp-style'));
  fs.writeFileSync(path.join(dir, '.claude-cpp-style', 'cpp-style.json'), JSON.stringify({ enabled: false }));
  const f = path.join(dir, 'main.cpp');
  fs.writeFileSync(f, 'int main(){return 0;}\n');
  const before = fs.readFileSync(f);
  const r = runHook({ tool_name: 'Edit', tool_input: { file_path: f } });
  assert.strictEqual(r.status, 0, 'enabled:false 应 exit 0');
  assert.strictEqual(r.stdout, '', 'enabled:false 应 stdout 空（no-op）');
  assert.ok(fs.readFileSync(f).equals(before), 'enabled:false 文件零改动（BOM 也不补）');
}

// 5) 协议铁律：任何情况都绝不 exit 2 / exit 1
{
  const r = runHook({ tool_name: 'Edit', tool_input: {} });
  assert.notStrictEqual(r.status, 2, '永不 exit 2');
  assert.notStrictEqual(r.status, 1, '永不 exit 1');
}

console.log('post_edit.integration.test.js PASS');
