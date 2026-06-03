const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findCMakeRoot, isCMakeProject } = require('../lib/project.js');

const cleanup = [];
try {
  // 文件同级有 CMakeLists.txt
  const root1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-'));
  cleanup.push(root1);
  fs.writeFileSync(path.join(root1, 'CMakeLists.txt'), 'project(x)');
  const f1 = path.join(root1, 'main.cpp');
  fs.writeFileSync(f1, 'int main(){}');
  assert.strictEqual(findCMakeRoot(f1), fs.realpathSync(root1), '同级命中');
  assert.strictEqual(isCMakeProject(f1), true, 'isCMakeProject true');

  // 上层有 CMakeLists.txt（文件在子目录）
  const sub = path.join(root1, 'src', 'core');
  fs.mkdirSync(sub, { recursive: true });
  const f2 = path.join(sub, 'a.cc');
  fs.writeFileSync(f2, 'int x;');
  assert.strictEqual(findCMakeRoot(f2), fs.realpathSync(root1), '上层向上找到');

  // 都没有 → null（非 CMake 项目）
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nocmake-'));
  cleanup.push(root2);
  const f3 = path.join(root2, 'b.cpp');
  fs.writeFileSync(f3, 'int y;');
  assert.strictEqual(findCMakeRoot(f3), null, '无 CMakeLists.txt → null');
  assert.strictEqual(isCMakeProject(f3), false, 'isCMakeProject false');

  // 非 git 的 CMake 项目（无 .git，但有 CMakeLists.txt）→ 仍命中
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-nogit-'));
  cleanup.push(root3);
  fs.writeFileSync(path.join(root3, 'CMakeLists.txt'), 'project(z)');
  const f4 = path.join(root3, 'z.cpp');
  fs.writeFileSync(f4, 'int z;');
  assert.strictEqual(isCMakeProject(f4), true, '非 git CMake 项目仍命中');

  // null / 不存在路径 → 不崩
  assert.strictEqual(findCMakeRoot(null), null, 'null 安全');
  assert.strictEqual(findCMakeRoot('/no/such/path/x.cpp'), null, '不存在路径安全');
  console.log('project.test.js PASS');
} finally {
  for (const dir of cleanup) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
