const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyCopyright } = require('../steps/copyright.js');

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copyright-'));
const created = [];
function write(name, buf) { const p = path.join(tmp, name); fs.writeFileSync(p, buf); created.push(p); return p; }
const info = (over) => ({ company: 'ACME', author: 'kevin', dateFormat: 'YYYY/MM/DD HH:mm', ...over });

try {
  // No header: insert one.
  const f1 = write('a.cpp', Buffer.from('int a;\n', 'utf-8'));
  applyCopyright(f1, info());
  let t1 = fs.readFileSync(f1, 'utf-8');
  assert.ok(/Copyright .*ACME/.test(t1), 'Insert a header with company name');
  assert.ok(/Author kevin/.test(t1), 'Insert the Author line');
  assert.ok(/Date \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(t1), 'Date line uses default format');
  assert.ok(/int a;/.test(t1), 'Original content is retained');

  // Empty company: do not write.
  const f2 = write('b.cpp', Buffer.from('int b;\n', 'utf-8'));
  const before2 = fs.readFileSync(f2);
  applyCopyright(f2, info({ company: '' }));
  assert.ok(fs.readFileSync(f2).equals(before2), 'Empty company does not write');

  // Adding a header to a BOM file retains BOM at the start.
  const f3 = write('c.cpp', Buffer.concat([BOM, Buffer.from('int c;\n', 'utf-8')]));
  applyCopyright(f3, info());
  const b3 = fs.readFileSync(f3);
  assert.ok(b3.slice(0, 3).equals(BOM), 'Adding a header to a BOM file retains BOM at the start.');
  assert.ok(!b3.slice(3, 6).equals(BOM), 'BOM is not duplicated');
  assert.ok(/Copyright/.test(b3.slice(3).toString('utf-8')), 'Copyright header follows BOM');

  // dateFormat YYYY-MM-DD takes effect.
  const f4 = write('d.cpp', Buffer.from('int d;\n', 'utf-8'));
  applyCopyright(f4, info({ dateFormat: 'YYYY-MM-DD' }));
  const t4 = fs.readFileSync(f4, 'utf-8');
  assert.ok(/Date \d{4}-\d{2}-\d{2}\b/.test(t4), 'dateFormat YYYY-MM-DD takes effect.');
  assert.ok(!/Date \d{4}-\d{2}-\d{2} /.test(t4), 'No time component');

  // dateFormat missing YMD components falls back to the timed default.
  const f5 = write('e.cpp', Buffer.from('int e;\n', 'utf-8'));
  applyCopyright(f5, info({ dateFormat: 'YYYY' }));
  const t5 = fs.readFileSync(f5, 'utf-8');
  assert.ok(/Date \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(t5), 'Incomplete dateFormat falls back to default');

  // Same-day deduplication: a second run does not refresh even if the minute changed.
  const today = new Date();
  const yyyy = String(today.getFullYear());
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const existing = `// Copyright (c) ${yyyy} ACME\n// Author kevin\n// Date ${yyyy}/${mm}/${dd} 00:00\n\nint f;\n`;
  const f6 = write('f.cpp', Buffer.from(existing, 'utf-8'));
  const before6 = fs.readFileSync(f6);
  applyCopyright(f6, info());
  assert.ok(fs.readFileSync(f6).equals(before6), 'Same-day rerun with another minute does not refresh');

  // Next day: update.
  const existingOld = `// Copyright (c) 2000 ACME\n// Author kevin\n// Date 2000/01/01 00:00\n\nint g;\n`;
  const f7 = write('g.cpp', Buffer.from(existingOld, 'utf-8'));
  applyCopyright(f7, info());
  const t7 = fs.readFileSync(f7, 'utf-8');
  assert.ok(t7.includes(`Date ${yyyy}/${mm}/${dd}`), 'Date updates on the next day');
  assert.ok(!t7.includes('2000/01/01'), 'Old Date is replaced');

  // When an old header touches ordinary comments, update only copyright semantic lines and preserve comments.
  const glued = `// Copyright (c) 2000 ACME\n// Author kevin\n// Date 2000/01/01 00:00\n// \u8fd9\u662f\u7528\u6237\u81ea\u5df1\u7684\u8bf4\u660e\u6ce8\u91ca\nint h;\n`;
  const f8 = write('h.cpp', Buffer.from(glued, 'utf-8'));
  applyCopyright(f8, info());
  const t8 = fs.readFileSync(f8, 'utf-8');
  assert.ok(t8.includes('// \u8fd9\u662f\u7528\u6237\u81ea\u5df1\u7684\u8bf4\u660e\u6ce8\u91ca'), 'Adjacent ordinary user comment is retained');
  assert.ok(t8.includes(`Date ${yyyy}/${mm}/${dd}`), 'Copyright Date updates to today');
  assert.ok(!t8.includes('2000/01/01'), 'Old copyright Date is replaced');
  assert.ok(/int h;/.test(t8), 'Original code is retained');

  // Preserve adjacent user comments resembling filenames without C/C++ extensions.
  const gluedMd = `// Copyright (c) 2000 ACME\n// Author kevin\n// Date 2000/01/01 00:00\n// \u8bf4\u660e.md\nint j;\n`;
  const f10 = write('j.cpp', Buffer.from(gluedMd, 'utf-8'));
  applyCopyright(f10, info());
  const t10 = fs.readFileSync(f10, 'utf-8');
  assert.ok(t10.includes('// \u8bf4\u660e.md'), 'Filename-like .md user comment is retained');
  assert.ok(t10.includes(`Date ${yyyy}/${mm}/${dd}`), 'Date updates to today');
  assert.ok(!t10.includes('2000/01/01'), 'Old Date is replaced');
  assert.ok(/int j;/.test(t10), 'Original code is retained');

  // Recognize and consume a real C/C++ filename line (.cpp).
  const gluedCpp = `// Copyright (c) 2000 ACME\n// Author kevin\n// Date 2000/01/01 00:00\n// k.cpp\nint k;\n`;
  const f11 = write('k.cpp', Buffer.from(gluedCpp, 'utf-8'));
  applyCopyright(f11, info());
  const t11 = fs.readFileSync(f11, 'utf-8');
  assert.ok(!t11.includes('// k.cpp'), 'C/C++ filename line is consumed');
  assert.ok(/int k;/.test(t11), 'Original code is retained');

  // With BOM and adjacent ordinary comments, preserve both BOM position and comments.
  const gluedBom = Buffer.concat([BOM, Buffer.from(glued.replace('int h;', 'int i;'), 'utf-8')]);
  const f9 = write('i.cpp', gluedBom);
  applyCopyright(f9, info());
  const b9 = fs.readFileSync(f9);
  assert.ok(b9.slice(0, 3).equals(BOM), 'Updated BOM file retains leading BOM');
  assert.ok(!b9.slice(3, 6).equals(BOM), 'BOM is not duplicated');
  assert.ok(b9.slice(3).toString('utf-8').includes('// \u8fd9\u662f\u7528\u6237\u81ea\u5df1\u7684\u8bf4\u660e\u6ce8\u91ca'), 'User comment in BOM file is retained');

  console.log('copyright.test.js PASS');
} finally {
  for (const p of created) { try { fs.unlinkSync(p); } catch (_) {} }
  try { fs.rmdirSync(tmp); } catch (_) {}
}
