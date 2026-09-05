'use strict';

const { validatedSessionId } = require('./guidance');

/** 只识别宿主创建任务时写入的委派封装；内部文本始终作为命名数据。 */
function delegationPrompt(item) {
  if (item.type !== 'functionCallOutput' || item.name !== 'create_thread'
    || item.namespace !== 'codex_app' || typeof item.output !== 'string') return null;
  const match = item.output.match(/^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/);
  if (!match || !validatedSessionId({ session_id: match[1] })) return null;
  return match[2];
}

/**
 * 从当前任务首个 turn 提取请求；不使用标题、preview、后续消息或项目上下文兜底。
 * null 表示宿主尚未提供首条请求，空字符串则表示明确的无文本请求。
 */
function firstPrompt(thread) {
  if (!Array.isArray(thread.turns)) return null;
  const items = thread.turns[0]?.items;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (item.type === 'userMessage') {
      if (!Array.isArray(item.content)) return null;
      return item.content.filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text).join('\n');
    }
    const delegated = delegationPrompt(item);
    if (delegated !== null) return delegated;
  }
  return null;
}

module.exports = { delegationPrompt, firstPrompt };
