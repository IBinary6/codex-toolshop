const assert = require('node:assert');
const path = require('path');
const { resolveFilePath, resolveFilePaths, shouldHandle, CPP_EXTENSIONS, EXCLUDED_DIRS, SKIPPED_FILES } = require('../lib/target.js');

// resolveFilePath: tool_input.file_path 直取
assert.strictEqual(
  resolveFilePath({ tool_input: { file_path: '/p/a.cpp' } }), '/p/a.cpp', 'file_path 直取');
// relative_path + cwd
assert.strictEqual(
  resolveFilePath({ cwd: '/proj', tool_input: { relative_path: 'src/a.cc' } }),
  path.resolve('/proj', 'src/a.cc'), 'relative_path 解析');
// 无路径
assert.strictEqual(resolveFilePath({}), null, '无路径返回 null');
assert.strictEqual(resolveFilePath(null), null, 'null 输入返回 null');
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
  'apply_patch 提取所有新增/更新文件并忽略删除文件'
);

// shouldHandle: 扩展名
assert.strictEqual(shouldHandle('/p/a.cpp'), true, '.cpp 处理');
assert.strictEqual(shouldHandle('/p/a.txt'), false, '.txt 不处理');
// SKIPPED_FILES
assert.strictEqual(shouldHandle('/p/resource.h'), false, 'resource.h 跳过');
// EXCLUDED_DIRS（路径含 node_modules）
assert.strictEqual(shouldHandle('/p/node_modules/a.cpp'), false, 'node_modules 跳过');
assert.strictEqual(shouldHandle('/p/build/a.cpp'), false, 'build 跳过');

// 常量
assert.ok(CPP_EXTENSIONS.has('.hpp'), '.hpp 在扩展名集');
assert.ok(EXCLUDED_DIRS.has('node_modules'), 'node_modules 在排除集');
assert.ok(SKIPPED_FILES.has('resource.h'), 'resource.h 在跳过集');

// 回归：子串目录不误判（mybuild/buildtools 含 'build' 子串但非排除目录本身）
assert.strictEqual(shouldHandle('/proj/mybuild/a.cpp'), true, 'mybuild 非排除目录');
assert.strictEqual(shouldHandle('/proj/buildtools/a.cpp'), true, 'buildtools 非排除目录');
assert.strictEqual(shouldHandle('/proj/build/a.cpp'), false, 'build 排除目录');

// 回归：扩展名大小写不敏感
assert.strictEqual(shouldHandle('/p/a.CPP'), true, '.CPP 大小写不敏感命中');
assert.strictEqual(shouldHandle('/p/a.Hpp'), true, '.Hpp 大小写不敏感命中');
// 回归：Windows 反斜杠路径 + 排除目录大小写不敏感
assert.strictEqual(shouldHandle('C:\\proj\\BUILD\\a.cpp'), false, 'BUILD 大小写不敏感排除');

// 回归：resolveFilePath 各形态
assert.strictEqual(
  resolveFilePath({ file_path: '/top/a.cpp' }), '/top/a.cpp', '顶层 input.file_path 回退');
assert.strictEqual(
  resolveFilePath({ tool_input: { path: '/p/b.cc' } }), '/p/b.cc', 'tool_input.path 分支');
assert.strictEqual(
  resolveFilePath({ tool_input: {} }), null, 'tool_input 缺失字段返回 null');

// 修复3：resolveFilePath 始终返回绝对路径
// 相对 file_path + input.cwd → 以 cwd 为基准绝对化（不再原样漏过相对值）
assert.strictEqual(
  resolveFilePath({ cwd: '/proj', tool_input: { file_path: 'src/a.cpp' } }),
  path.resolve('/proj', 'src/a.cpp'),
  '相对 file_path 以 cwd 绝对化');
// 相对 path 同理
assert.strictEqual(
  resolveFilePath({ cwd: '/proj', tool_input: { path: 'src/b.cc' } }),
  path.resolve('/proj', 'src/b.cc'),
  '相对 path 以 cwd 绝对化');
// 绝对 file_path → 原样返回
assert.strictEqual(
  resolveFilePath({ cwd: '/elsewhere', tool_input: { file_path: '/abs/a.cpp' } }),
  '/abs/a.cpp',
  '绝对 file_path 原样（cwd 不影响）');
// 顶层相对 fallback 也绝对化
assert.strictEqual(
  resolveFilePath({ cwd: '/proj', file_path: 'rel.cpp' }),
  path.resolve('/proj', 'rel.cpp'),
  '顶层相对 file_path 以 cwd 绝对化');
// relative_path 分支不变
assert.strictEqual(
  resolveFilePath({ cwd: '/proj', tool_input: { relative_path: 'src/c.cc' } }),
  path.resolve('/proj', 'src/c.cc'),
  'relative_path 分支不变');

console.log('target.test.js PASS');
