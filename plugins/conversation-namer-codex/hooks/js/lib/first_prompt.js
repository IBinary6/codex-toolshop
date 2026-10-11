'use strict';

const { validatedSessionId } = require('./guidance');

/** Recognize only delegation envelopes written by the host when creating a task; treat their contents solely as naming data. */
function delegationPrompt(item) {
  if (item.type !== 'functionCallOutput' || item.name !== 'create_thread'
    || item.namespace !== 'codex_app' || typeof item.output !== 'string') return null;
  const match = item.output.match(/^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/);
  if (!match || !validatedSessionId({ session_id: match[1] })) return null;
  return match[2];
}

/**
 * Extract the request from the current task first turn; do not fall back to titles, previews, later messages, or project context.
 * null means the host has not supplied the first request; an empty string means an explicitly textless request.
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
