const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findCMakeRoot, isCMakeProject } = require('../lib/project.js');

const cleanup = [];
try {
  // CMakeLists.txt alongside the file.
  const root1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-'));
  cleanup.push(root1);
  fs.writeFileSync(path.join(root1, 'CMakeLists.txt'), 'project(x)');
  const f1 = path.join(root1, 'main.cpp');
  fs.writeFileSync(f1, 'int main(){}');
  assert.strictEqual(findCMakeRoot(f1), fs.realpathSync(root1), 'Finds the root at the same level');
  assert.strictEqual(isCMakeProject(f1), true, 'isCMakeProject true');

  // CMakeLists.txt in an ancestor directory.
  const sub = path.join(root1, 'src', 'core');
  fs.mkdirSync(sub, { recursive: true });
  const f2 = path.join(sub, 'a.cc');
  fs.writeFileSync(f2, 'int x;');
  assert.strictEqual(findCMakeRoot(f2), fs.realpathSync(root1), 'Finds the root in an ancestor');

  // No marker: null (not a CMake project).
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nocmake-'));
  cleanup.push(root2);
  const f3 = path.join(root2, 'b.cpp');
  fs.writeFileSync(f3, 'int y;');
  assert.strictEqual(findCMakeRoot(f3), null, 'Returns null without CMakeLists.txt');
  assert.strictEqual(isCMakeProject(f3), false, 'isCMakeProject false');

  // A CMake project outside Git still matches CMakeLists.txt.
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-nogit-'));
  cleanup.push(root3);
  fs.writeFileSync(path.join(root3, 'CMakeLists.txt'), 'project(z)');
  const f4 = path.join(root3, 'z.cpp');
  fs.writeFileSync(f4, 'int z;');
  assert.strictEqual(isCMakeProject(f4), true, 'Finds a CMake project outside Git');

  // Null or nonexistent path does not crash.
  assert.strictEqual(findCMakeRoot(null), null, 'Handles null safely');
  assert.strictEqual(findCMakeRoot('/no/such/path/x.cpp'), null, 'Handles a nonexistent path safely');
  console.log('project.test.js PASS');
} finally {
  for (const dir of cleanup) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
