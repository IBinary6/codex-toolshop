const assert = require('node:assert');
const path = require('path');
const { resolveFilePath, resolveFilePaths, shouldHandle, CPP_EXTENSIONS, EXCLUDED_DIRS, SKIPPED_FILES } = require('../lib/target.js');

// resolveFilePath reads tool_input.file_path directly.
assert.strictEqual(
  resolveFilePath({ tool_input: { file_path: '/p/a.cpp' } }), '/p/a.cpp', 'Reads file_path directly');
// relative_path + cwd
assert.strictEqual(
  resolveFilePath({ cwd: '/proj', tool_input: { relative_path: 'src/a.cc' } }),
  path.resolve('/proj', 'src/a.cc'), 'Resolves relative_path');
// No path.
assert.strictEqual(resolveFilePath({}), null, 'Returns null when no path is present');
assert.strictEqual(resolveFilePath(null), null, 'Null input returns null');
assert.deepStrictEqual(
  resolveFilePaths({
    cwd: '/proj',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Add File: src/new.cpp',
        '*** Update File: include/existing.hpp',
        '*** Delete File: src/removed.cpp',
        '*** End Patch',
      ].join('\n'),
    },
  }),
  [path.resolve('/proj', 'src/new.cpp'), path.resolve('/proj', 'include/existing.hpp')],
  'apply_patch collects all added or updated files and ignores deletions'
);

// shouldHandle: extensions.
assert.strictEqual(shouldHandle('/p/a.cpp'), true, 'Handles .cpp files');
assert.strictEqual(shouldHandle('/p/a.txt'), false, 'Ignores .txt files');
// SKIPPED_FILES
assert.strictEqual(shouldHandle('/p/resource.h'), false, 'Skips resource.h');
// EXCLUDED_DIRS for paths containing node_modules.
assert.strictEqual(shouldHandle('/p/node_modules/a.cpp'), false, 'Skips node_modules');
assert.strictEqual(shouldHandle('/p/build/a.cpp'), false, 'Skips build');

// Constants.
assert.ok(CPP_EXTENSIONS.has('.hpp'), '.hpp is in the extension set');
assert.ok(EXCLUDED_DIRS.has('node_modules'), 'node_modules is in the exclusion set');
assert.ok(SKIPPED_FILES.has('resource.h'), 'resource.h is in the skipped-file set');

// Regression: do not exclude mybuild/buildtools just for containing the build substring.
assert.strictEqual(shouldHandle('/proj/mybuild/a.cpp'), true, 'mybuild is not an excluded directory');
assert.strictEqual(shouldHandle('/proj/buildtools/a.cpp'), true, 'buildtools is not an excluded directory');
assert.strictEqual(shouldHandle('/proj/build/a.cpp'), false, 'build is an excluded directory');
for (const dir of ['3rd', '3rdparty', '3rd_party', '3rd-party', 'thirdparty', 'third_party',
  'third-party', 'thirdpart', 'third_part', 'third-part', 'thridpart', 'thridparty',
  'thrid_party', 'thrid-party', 'vendor', 'external', 'deps', 'packages']) {
  assert.strictEqual(shouldHandle(`/proj/${dir}/lib/a.cpp`), false, dir);
  assert.strictEqual(shouldHandle(`C:\\proj\\${dir.toUpperCase()}\\lib\\a.cpp`), false, dir);
}
assert.strictEqual(shouldHandle('/proj/third_party_adapter/a.cpp'), true);
assert.strictEqual(shouldHandle('/proj/vendor_manager/a.cpp'), true);

// Regression: extension matching ignores case.
assert.strictEqual(shouldHandle('/p/a.CPP'), true, 'Handles .CPP case-insensitively');
assert.strictEqual(shouldHandle('/p/a.Hpp'), true, 'Handles .Hpp case-insensitively');
// Regression: Windows backslashes and excluded-directory case insensitivity.
assert.strictEqual(shouldHandle('C:\\proj\\BUILD\\a.cpp'), false, 'Excludes BUILD case-insensitively');

// Regression: resolveFilePath input shapes.
assert.strictEqual(
  resolveFilePath({ file_path: '/top/a.cpp' }), '/top/a.cpp', 'Falls back to top-level input.file_path');
assert.strictEqual(
  resolveFilePath({ tool_input: { path: '/p/b.cc' } }), '/p/b.cc', 'Handles tool_input.path');
assert.strictEqual(
  resolveFilePath({ tool_input: {} }), null, 'Missing tool_input field returns null');

// Fix 3: resolveFilePath always returns absolute paths.
// Relative file_path with input.cwd resolves against cwd instead of passing through.
assert.strictEqual(
  resolveFilePath({ cwd: '/proj', tool_input: { file_path: 'src/a.cpp' } }),
  path.resolve('/proj', 'src/a.cpp'),
  'Resolves relative file_path against cwd');
// Relative path behaves the same.
assert.strictEqual(
  resolveFilePath({ cwd: '/proj', tool_input: { path: 'src/b.cc' } }),
  path.resolve('/proj', 'src/b.cc'),
  'Resolves relative path against cwd');
// Absolute file_path is returned unchanged.
assert.strictEqual(
  resolveFilePath({ cwd: '/elsewhere', tool_input: { file_path: '/abs/a.cpp' } }),
  '/abs/a.cpp',
  'Keeps absolute file_path unchanged regardless of cwd');
// Top-level relative fallback is also made absolute.
assert.strictEqual(
  resolveFilePath({ cwd: '/proj', file_path: 'rel.cpp' }),
  path.resolve('/proj', 'rel.cpp'),
  'Resolves top-level relative file_path against cwd');
// relative_path behavior is unchanged.
assert.strictEqual(
  resolveFilePath({ cwd: '/proj', tool_input: { relative_path: 'src/c.cc' } }),
  path.resolve('/proj', 'src/c.cc'),
  'relative_path behavior is unchanged.');

assert.deepStrictEqual(resolveFilePaths({
  cwd: '/proj', tool_name: 'apply_patch', tool_input: [
    '*** Begin Patch', '*** Update File: src/a.cpp',
    '*** Move to: src/renamed.cpp', '*** Add File: include/new.hpp', '*** End Patch',
  ].join('\n'),
}), [path.resolve('/proj', 'src/a.cpp'), path.resolve('/proj', 'src/renamed.cpp'),
  path.resolve('/proj', 'include/new.hpp')], 'Recognizes all target files in freeform apply_patch text');

console.log('target.test.js PASS');
