'use strict';

const assert = require('node:assert');
const { formatChangedFiles, MAX_CHANGED_FILES_SHOWN } = require('../lib/report');

assert.strictEqual(
  formatChangedFiles(['a.cc', 'b.cc']),
  '  - a.cc\n  - b.cc',
  '少量文件应完整显示',
);

const manyFiles = Array.from(
  { length: MAX_CHANGED_FILES_SHOWN + 3 },
  (_, index) => `file-${index}.cc`,
);
const report = formatChangedFiles(manyFiles);
assert.ok(report.includes(`  - file-${MAX_CHANGED_FILES_SHOWN - 1}.cc`));
assert.ok(!report.includes(`  - file-${MAX_CHANGED_FILES_SHOWN}.cc`));
assert.ok(report.includes('还有 3 个文件未显示'));

console.log('report.test.js PASS');
