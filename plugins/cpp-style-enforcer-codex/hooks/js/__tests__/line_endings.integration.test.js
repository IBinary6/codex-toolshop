'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runCpplint } = require('../steps/cpplint');

const pluginRoot = path.resolve(__dirname, '../../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-eol-hooks-'));
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: tmp, encoding: 'utf8', windowsHide: true, ...opts });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function git(...args) { return run('git', args); }
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const source = path.join(tmp, 'main.cpp');
const config = path.join(tmp, '.codex-cpp-style/cpp-style.json');
function stop(turn) {
  const input = { cwd: tmp, session_id: 'eol', turn_id: turn, tool_input: { file_path: source } };
  const opts = { env: { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: path.join(tmp, 'data') } };
  run(process.execPath, [path.join(pluginRoot, 'scripts/run-hook.cjs'), 'post_edit'], { ...opts, input: JSON.stringify(input) });
  return JSON.parse(run(process.execPath, [path.join(pluginRoot, 'scripts/run-hook.cjs'), 'stop_check'], { ...opts, input: JSON.stringify(input) }));
}
try {
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(tmp, '.gitattributes'), '*.cpp text eol=crlf\n');
  fs.writeFileSync(path.join(tmp, 'app.vcxproj'), '<Project />');
  fs.mkdirSync(path.dirname(config));
  fs.writeFileSync(config, JSON.stringify({
    mode: 'incremental', lineEnding: 'lf',
    checks: { clangFormat: false, bom: false, copyright: false, cpplint: true },
    legacyChecks: { clangFormat: false, bom: false, copyright: false, cpplint: true },
    copyrightInfo: { company: '' },
  }));
  fs.writeFileSync(source, Buffer.concat([bom, Buffer.from('int main() {\r\n  return 0;\r\n}\r\n')]));
  git('add', '.gitattributes', 'app.vcxproj', 'main.cpp');
  git('commit', '-qm', 'baseline');

  // 模拟编辑器写成 LF，末尾补 CRLF 会混合；旧 cpplint 会进一步建议转 LF。
  fs.writeFileSync(source, Buffer.concat([bom, Buffer.from('int main() {\n  return 1;\r\n}')]));
  const beforeLint = fs.readFileSync(source);
  const diagnostics = runCpplint(source, { root: tmp, suppressCopyright: true });
  assert.ok(diagnostics.some(v => v.category === 'whitespace/ending_newline'));
  const mixed = diagnostics.find(v => v.category === 'whitespace/newline');
  assert.ok(mixed);
  assert.match(mixed.message, /consistent project line ending/);
  assert.doesNotMatch(mixed.message, /better to use only/);
  assert.deepEqual(fs.readFileSync(source), beforeLint, '检查本身只读');
  const result = stop('first');
  assert.doesNotMatch(result.reason || '', /cpplint 检测到/);
  const expected = Buffer.concat([bom, Buffer.from('int main() {\r\n  return 1;\r\n}\r\n')]);
  assert.deepEqual(fs.readFileSync(source), expected, '旧文件关闭 clang-format 仍统一 CRLF 并补末尾');
  const mtime = fs.statSync(source).mtimeMs;
  assert.deepEqual(stop('second'), {});
  assert.equal(fs.statSync(source).mtimeMs, mtime, '反复触碰不重复修复或报告');

  // 暂存缺末尾换行，Stop 修工作区后不能静默改写 index 或吞掉暂存检查。
  fs.writeFileSync(source, 'int main() { return 2; }');
  git('add', 'main.cpp');
  const stagedBefore = git('show', ':main.cpp');
  stop('third');
  assert.equal(git('show', ':main.cpp'), stagedBefore);
  const commitInput = JSON.stringify({ cwd: tmp, tool_input: { command: 'git commit -m test' } });
  const commitHook = () => run(process.execPath, [path.join(pluginRoot, 'hooks/js/pre_commit.js')], { input: commitInput });
  assert.match(commitHook(), /ending_newline/);
  git('add', 'main.cpp');
  const staged = git('show', ':main.cpp');
  assert.ok(staged.endsWith('\n') && !staged.includes('\r'), 'Git index 可正常存 LF');
  assert.equal(commitHook(), '', 'CRLF 工作区配合 LF index 正常通过');
  const includes = '#include <windows.h>\r\n#include <LdsLog/lds_log.h>\r\n\r\nint main() { return 0; }\r\n';
  fs.writeFileSync(source, includes);
  assert.deepEqual(stop('vs-includes'), {}, 'Stop 不要求重排 VS include');
  git('add', 'main.cpp');
  assert.equal(commitHook(), '', '暂存快照没有 vcxproj 时仍应用 VS include 策略');

  // VS 旧项目关闭所有高层风格检查仍执行基础行尾规则。
  const settings = JSON.parse(fs.readFileSync(config));
  settings.legacyChecks.cpplint = false;
  fs.writeFileSync(config, JSON.stringify(settings));
  fs.writeFileSync(source, 'int main() { return 3; }');
  stop('fourth');
  assert.equal(fs.readFileSync(source, 'utf8'), 'int main() { return 3; }\r\n');

  // 全流程会新增版权头/格式化行尾，最终必须再次统一到 VS 的 CRLF。
  settings.mode = 'full';
  settings.checks.clangFormat = true;
  settings.checks.copyright = true;
  settings.copyrightInfo.company = 'Example';
  fs.writeFileSync(config, JSON.stringify(settings));
  fs.writeFileSync(source, Buffer.concat([bom, Buffer.from('int main() { return 5; }')]));
  const full = stop('full-pipeline');
  const finalText = fs.readFileSync(source).subarray(3).toString('utf8');
  assert.ok(fs.readFileSync(source).subarray(0, 3).equals(bom));
  assert.match(finalText, /^\/\/ Copyright/);
  assert.ok(finalText.endsWith('\r\n'));
  assert.ok(!finalText.replace(/\r\n/g, '').includes('\n'));
  assert.doesNotMatch(full.reason || '', /cpplint 检测到/);
  assert.deepEqual(stop('full-repeat'), {});

  // 最近 CMake 源目录优先，其他工程的 LF 配置实际生效。
  settings.mode = 'incremental';
  fs.writeFileSync(config, JSON.stringify(settings));
  fs.writeFileSync(source, 'int main() { return 3; }\r\n');
  fs.writeFileSync(path.join(tmp, 'CMakeLists.txt'), 'project(example)\n');
  stop('fifth');
  assert.equal(fs.readFileSync(source, 'utf8'), 'int main() { return 3; }\n');
  settings.enabled = false;
  fs.writeFileSync(config, JSON.stringify(settings));
  fs.writeFileSync(source, 'int main() { return 4; }');
  assert.deepEqual(stop('disabled'), {});
  assert.equal(fs.readFileSync(source, 'utf8'), 'int main() { return 4; }');
  console.log('line_endings.integration.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
