'use strict';

const { additionalContext, passSilent, readStdinJson } = require('./lib/runtime');
const { isCodeMapEnabled } = require('./lib/codemap');
const { SEARCH_CONTEXT, looksLikeCodeSearch, claimSearchReminder } = require('./lib/search_reminder');

/** 搜索前只补充一次短提醒，不改写命令或触发图刷新。@example main() */
async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  // 普通命令先静默返回，避免每个 shell 调用都探测图运行时。
  if (!looksLikeCodeSearch(input) || !isCodeMapEnabled()) return passSilent();
  if (!claimSearchReminder(input)) return passSilent();
  return additionalContext('PreToolUse', SEARCH_CONTEXT);
}

main().catch(() => passSilent());
