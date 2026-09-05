'use strict';

const { additionalContext, hookCwd, passSilent, readStdinJson, repoRoot } = require('./lib/runtime');
const { CONTEXT, isCodeMapEnabled, promptLooksStructural } = require('./lib/codemap');
const { resetSearchReminder } = require('./lib/search_reminder');

function promptText(input) {
  if (!input || typeof input !== 'object') return '';
  return input.prompt || input.user_prompt || input.message || input.text || '';
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  if (!repoRoot(hookCwd(input))) return passSilent();
  resetSearchReminder(input);
  if (!isCodeMapEnabled() || !promptLooksStructural(promptText(input))) return passSilent();
  // 关键词只提示可用能力；真正访问图谱时由 barrier 刷新，不阻塞纯咨询。
  return additionalContext('UserPromptSubmit', CONTEXT);
}

main().catch(() => passSilent());
