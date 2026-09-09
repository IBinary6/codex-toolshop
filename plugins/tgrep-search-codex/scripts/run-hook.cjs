#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { context, managed, start } = require('./tgrep.cjs');
(async () => {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const event = process.argv[2] === 'session_start' ? 'SessionStart' : 'UserPromptSubmit';
  const ctx = context(input.cwd || process.cwd());
  if (!ctx?.git) return;
  const state = await managed(ctx, 'touch');
  if (!state) start(ctx);
  if (event === 'UserPromptSubmit') return;
  const cli = "'" + path.join(__dirname, 'tgrep.cjs').split("'").join("'" + String.fromCharCode(92) + "''") + "'";
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: `tgrep 文本搜索入口：node ${cli} search -n -- "pattern" .；状态 ${state?.phase || 'starting/pending'}。--fresh 直读磁盘；首次索引、异常和零命中自动扫描复核。符号、调用链、影响面仍先用 CodeMap；已知文件直接读。诊断：node ${cli} doctor。` } }));
})().catch(e => { console.error(`[tgrep hook] ${e.message}`); process.exitCode = 0; });
