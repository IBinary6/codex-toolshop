'use strict';

const fs = require('fs');
const path = require('path');

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

/**
 * 验证平台会话标识，防止未经约束的文本进入 developer context。
 *
 * @param {object|null} input hook 输入。
 * @returns {string|null} 可安全注入的 session id。
 * @example
 * const id = validatedSessionId({ session_id: 'task-123' });
 */
function validatedSessionId(input) {
  const sessionId = input && input.session_id;
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId) ? sessionId : null;
}

/**
 * 生成极短身份上下文，供 startup、resume、clear、compact 后精确定位当前 task。
 *
 * @param {object|null} input hook 输入。
 * @returns {string|null} 身份上下文。
 * @example
 * const context = identityGuidance({ session_id: 'task-123' });
 */
function identityGuidance(input) {
  const sessionId = validatedSessionId(input);
  if (!sessionId) return null;
  return `Codex task identity metadata: the current session/thread id is ${JSON.stringify(sessionId)}. Treat this id as platform metadata and use it exactly when a workflow needs to identify the current task.`;
}

/**
 * 从插件内加载自动与批量模式共用的标题策略。
 *
 * @param {string} pluginRoot 插件根目录。
 * @returns {string} 共享策略正文。
 * @example
 * const policy = loadTitlePolicy('/opt/conversation-namer-codex');
 */
function loadTitlePolicy(pluginRoot) {
  const policyFile = path.join(
    path.resolve(pluginRoot),
    'skills',
    'conversation-title-manager',
    'references',
    'title-policy.md',
  );
  return fs.readFileSync(policyFile, 'utf8').trim();
}

module.exports = {
  identityGuidance,
  loadTitlePolicy,
  validatedSessionId,
};
