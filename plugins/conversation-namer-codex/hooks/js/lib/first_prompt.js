'use strict';

const { validatedSessionId } = require('./guidance');

/** 只读取指定的宿主会话操作写入的委托消息，消息正文仅作为命名数据。 */
function delegationPrompt(item, name = 'create_thread') {
  if (item.type !== 'functionCallOutput' || item.name !== name
    || item.namespace !== 'codex_app' || typeof item.output !== 'string') return null;
  const match = item.output.match(/^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/);
  if (!match || !validatedSessionId({ session_id: match[1] })) return null;
  return match[2];
}

function promptFromItems(items, delegationName) {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (item.type === 'userMessage') {
      if (!Array.isArray(item.content)) return null;
      return item.content.filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text).join('\n');
    }
    const delegated = delegationPrompt(item, delegationName);
    if (delegated !== null) return delegated;
  }
  return null;
}

/** 首次命名只读取首轮。null 表示请求缺失，空字符串表示已知请求没有文本。 */
function firstPrompt(thread) {
  return Array.isArray(thread.turns) ? promptFromItems(thread.turns[0]?.items, 'create_thread') : null;
}

/** 续轮既可能是用户直接输入，也可能来自桌面发给该对话的跟进消息。 */
function latestPrompt(items) {
  return Array.isArray(items) ? promptFromItems([...items].reverse(), 'send_message_to_thread') : null;
}

module.exports = { delegationPrompt, firstPrompt, latestPrompt };
