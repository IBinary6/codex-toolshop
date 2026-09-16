'use strict';

const { additionalContext, hookCwd, passSilent, readStdinJson, repoRoot } = require('./lib/runtime');
const { CONTEXT, promptLooksStructural } = require('./lib/codemap');
const { resetSearchReminder } = require('./lib/search_reminder');

function promptText(input) {
  if (!input || typeof input !== 'object') return '';
  return input.prompt || input.user_prompt || input.message || input.text || '';
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  const root = repoRoot(hookCwd(input));
  // 非 Git 会话不写提醒状态；结构请求仍可获得工具发现与回退指导。
  if (root) resetSearchReminder(input);
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1'
    || !promptLooksStructural(promptText(input))) return passSilent();
  // 关键词只提示可用能力；真正访问图谱时由 barrier 刷新，不阻塞纯咨询。
  return additionalContext('UserPromptSubmit', CONTEXT);
}

main().catch(() => passSilent());
