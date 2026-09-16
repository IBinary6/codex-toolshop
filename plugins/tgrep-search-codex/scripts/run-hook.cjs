#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const tgrep = require('./tgrep.cjs');

const events = {
  session_start: 'SessionStart',
  subagent_start: 'SubagentStart',
  user_prompt_submit: 'UserPromptSubmit'
};

function cliArgument(file) {
  return "'" + file.split("'").join("'" + String.fromCharCode(92) + "''") + "'";
}

function entryGuidance(file) {
  const cli = cliArgument(file);
  return `tgrep CLI（不是 MCP）：在目标 workdir 运行 node ${cli} search -n -- "pattern" PATH...。相对 PATH 按 workdir 解析；--root 只指定服务/扫描根，不改变 PATH。`;
}

function emit(write, event, additionalContext) {
  write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}

async function runHook(eventArgument, input = {}, api = tgrep, write = console.log, cliFile = path.join(__dirname, 'tgrep.cjs')) {
  const event = events[eventArgument];
  if (!event) throw new Error(`unknown hook event: ${eventArgument}`);
  const guidance = entryGuidance(cliFile);

  // 子代理需要立即获得确定的入口；此事件不能触发仓库探测、更新、安装或服务生命周期。
  if (event === 'SubagentStart') {
    emit(write, event, guidance);
    return;
  }

  const ctx = api.context(input.cwd || process.cwd());
  if (!ctx?.git) {
    // 普通目录只提示无索引扫描入口，不因 SessionStart 创建状态或启动后台工作。
    if (event === 'SessionStart') emit(write, event, guidance);
    return;
  }

  api.maybeCheckUpdates();
  const state = await api.managed(ctx, 'touch');
  if (!state) api.start(ctx);
  if (event === 'UserPromptSubmit') return;
  const cli = cliArgument(cliFile);
  emit(write, event, `${guidance} 状态 ${state?.phase || 'starting/pending'}；--fresh 直读磁盘，首次索引、异常和零命中自动扫描复核。符号、调用链、影响面仍先用 CodeMap；已知文件直接读。诊断：node ${cli} doctor。`);
}

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  await runHook(process.argv[2], input);
}

module.exports = { entryGuidance, runHook };
if (require.main === module) main().catch(e => { console.error(`[tgrep hook] ${e.message}`); process.exitCode = 0; });
