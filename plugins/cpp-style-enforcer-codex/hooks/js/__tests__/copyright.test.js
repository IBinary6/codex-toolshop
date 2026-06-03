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
  // 无头 → 插入
  const f1 = write('a.cpp', Buffer.from('int a;\n', 'utf-8'));
  applyCopyright(f1, info());
  let t1 = fs.readFileSync(f1, 'utf-8');
  assert.ok(/Copyright .*ACME/.test(t1), '插入含公司名版权头');
  assert.ok(/Author kevin/.test(t1), '插入 Author 行');
  assert.ok(/Date \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(t1), 'Date 行按默认格式');
  assert.ok(/int a;/.test(t1), '原内容保留');

  // company 空 → 不写
  const f2 = write('b.cpp', Buffer.from('int b;\n', 'utf-8'));
  const before2 = fs.readFileSync(f2);
  applyCopyright(f2, info({ company: '' }));
  assert.ok(fs.readFileSync(f2).equals(before2), 'company 空不写');

  // 含 BOM 插头后 BOM 仍首字节
  const f3 = write('c.cpp', Buffer.concat([BOM, Buffer.from('int c;\n', 'utf-8')]));
  applyCopyright(f3, info());
  const b3 = fs.readFileSync(f3);
  assert.ok(b3.slice(0, 3).equals(BOM), '含 BOM 插头后 BOM 仍首字节');
  assert.ok(!b3.slice(3, 6).equals(BOM), 'BOM 不重复');
  assert.ok(/Copyright/.test(b3.slice(3).toString('utf-8')), '版权头在 BOM 之后');

  // dateFormat YYYY-MM-DD 生效
  const f4 = write('d.cpp', Buffer.from('int d;\n', 'utf-8'));
  applyCopyright(f4, info({ dateFormat: 'YYYY-MM-DD' }));
  const t4 = fs.readFileSync(f4, 'utf-8');
  assert.ok(/Date \d{4}-\d{2}-\d{2}\b/.test(t4), 'dateFormat YYYY-MM-DD 生效');
  assert.ok(!/Date \d{4}-\d{2}-\d{2} /.test(t4), '无时间部分');

  // dateFormat 缺 YMD（仅 YYYY）→ 回退默认带时间
  const f5 = write('e.cpp', Buffer.from('int e;\n', 'utf-8'));
  applyCopyright(f5, info({ dateFormat: 'YYYY' }));
  const t5 = fs.readFileSync(f5, 'utf-8');
  assert.ok(/Date \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(t5), 'dateFormat 缺 YMD 回退默认格式');

  // 同日去重：第二次（即使分钟不同）不刷新 —— 模拟已有今日头
  const today = new Date();
  const yyyy = String(today.getFullYear());
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const existing = `// Copyright (c) ${yyyy} ACME\n// Author kevin\n// Date ${yyyy}/${mm}/${dd} 00:00\n\nint f;\n`;
  const f6 = write('f.cpp', Buffer.from(existing, 'utf-8'));
  const before6 = fs.readFileSync(f6);
  applyCopyright(f6, info());
  assert.ok(fs.readFileSync(f6).equals(before6), '同日（分钟不同）→ 不刷新整次跳过');

  // 跨天 → 更新
  const existingOld = `// Copyright (c) 2000 ACME\n// Author kevin\n// Date 2000/01/01 00:00\n\nint g;\n`;
  const f7 = write('g.cpp', Buffer.from(existingOld, 'utf-8'));
  applyCopyright(f7, info());
  const t7 = fs.readFileSync(f7, 'utf-8');
  assert.ok(t7.includes(`Date ${yyyy}/${mm}/${dd}`), '跨天 → Date 更新为今天');
  assert.ok(!t7.includes('2000/01/01'), '旧 Date 被替换');

  // 旧版权块与用户普通注释零空行粘连：更新时只替换版权语义行，普通注释保留
  const glued = `// Copyright (c) 2000 ACME\n// Author kevin\n// Date 2000/01/01 00:00\n// 这是用户自己的说明注释\nint h;\n`;
  const f8 = write('h.cpp', Buffer.from(glued, 'utf-8'));
  applyCopyright(f8, info());
  const t8 = fs.readFileSync(f8, 'utf-8');
  assert.ok(t8.includes('// 这是用户自己的说明注释'), '粘连的用户普通注释不被误删');
  assert.ok(t8.includes(`Date ${yyyy}/${mm}/${dd}`), '版权头 Date 更新为今天');
  assert.ok(!t8.includes('2000/01/01'), '旧版权 Date 被替换');
  assert.ok(/int h;/.test(t8), '原代码保留');

  // 形似文件名的用户注释（非 C/C++ 源码后缀）紧贴版权块：更新时应保留，不被当文件名行吞掉
  const gluedMd = `// Copyright (c) 2000 ACME\n// Author kevin\n// Date 2000/01/01 00:00\n// 说明.md\nint j;\n`;
  const f10 = write('j.cpp', Buffer.from(gluedMd, 'utf-8'));
  applyCopyright(f10, info());
  const t10 = fs.readFileSync(f10, 'utf-8');
  assert.ok(t10.includes('// 说明.md'), '形似文件名的用户注释（.md）应保留');
  assert.ok(t10.includes(`Date ${yyyy}/${mm}/${dd}`), 'Date 更新为今天');
  assert.ok(!t10.includes('2000/01/01'), '旧 Date 被替换');
  assert.ok(/int j;/.test(t10), '原代码保留');

  // 真正的 C/C++ 文件名行（.cpp）仍应被吞掉
  const gluedCpp = `// Copyright (c) 2000 ACME\n// Author kevin\n// Date 2000/01/01 00:00\n// k.cpp\nint k;\n`;
  const f11 = write('k.cpp', Buffer.from(gluedCpp, 'utf-8'));
  applyCopyright(f11, info());
  const t11 = fs.readFileSync(f11, 'utf-8');
  assert.ok(!t11.includes('// k.cpp'), 'C/C++ 源码后缀的文件名行被吞掉');
  assert.ok(/int k;/.test(t11), '原代码保留');

  // 含 BOM 且粘连普通注释：BOM 仍首字节，注释保留
  const gluedBom = Buffer.concat([BOM, Buffer.from(glued.replace('int h;', 'int i;'), 'utf-8')]);
  const f9 = write('i.cpp', gluedBom);
  applyCopyright(f9, info());
  const b9 = fs.readFileSync(f9);
  assert.ok(b9.slice(0, 3).equals(BOM), '更新含 BOM 文件后 BOM 仍首字节');
  assert.ok(!b9.slice(3, 6).equals(BOM), 'BOM 不重复');
  assert.ok(b9.slice(3).toString('utf-8').includes('// 这是用户自己的说明注释'), 'BOM 文件中用户注释保留');

  console.log('copyright.test.js PASS');
} finally {
  for (const p of created) { try { fs.unlinkSync(p); } catch (_) {} }
  try { fs.rmdirSync(tmp); } catch (_) {}
}
