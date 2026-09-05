'use strict';

const fs = require('fs');

/**
 * 从标准输入读取单个 Codex hook JSON 对象；无效输入按 fail-open 处理。
 *
 * @returns {object|null} 已解析对象，或空值。
 * @example
 * const input = readStdinJson();
 */
function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/**
 * 按 Codex JSONL 协议输出额外 developer context。
 *
 * @param {string} eventName hook 事件名。
 * @param {string} additionalContext 要注入的上下文。
 * @returns {void}
 * @example
 * writeHookContext('SessionStart', 'Current task id: abc');
 */
function writeHookContext(eventName, additionalContext) {
  if (!additionalContext) return;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  })}\n`);
}

module.exports = { readStdinJson, writeHookContext };
