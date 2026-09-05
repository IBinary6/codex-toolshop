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

/**
 * 生成只用于新会话首条请求的语义命名指令。
 *
 * @param {string} pluginRoot 插件根目录。
 * @param {object|null} input hook 输入。
 * @returns {string|null} 自动命名 developer context。
 * @example
 * const context = automaticNamingGuidance('/opt/plugin', { session_id: 'task-123' });
 */
function automaticNamingGuidance(pluginRoot, input) {
  const sessionId = validatedSessionId(input);
  if (!sessionId) return null;
  const policy = loadTitlePolicy(pluginRoot);
  return [
    'Conversation-title automation is authorized only while handling the first user request after this startup SessionStart.',
    `Current session/thread id: ${JSON.stringify(sessionId)}.`,
    'Batch precedence: if the first request asks to rename or normalize conversations in the current project, do not automatically rename this task. Follow conversation-title-manager instead, including its read-only preview and confirmation gate.',
    'Treat automatic naming as a mandatory pre-task gate for every newly created Codex main task. Once you understand the first request well enough to identify its core topic, act immediately and before calling any unrelated tool or any repository, file, shell, browser, search, planning, or subagent tool used for that work. Do not omit this gate merely because the request is short, simple, or already actionable.',
    'First call mcp__codex_app__read_thread on that exact id to obtain createdAt, the current title, and the actual task context. Apply the shared policy below semantically; do not classify by a keyword map.',
    'If the read result already contains an assistant turn, or mcp__codex_app__set_thread_title has already been called for this task, this startup-only instruction is stale: safely skip the write and continue.',
    'Compute the target title only when the topic is reliable. If the current title already exactly equals the target title, do not call mcp__codex_app__set_thread_title. Otherwise, immediately call mcp__codex_app__set_thread_title exactly once for this current id.',
    'Only after this naming gate has completed or safely skipped may you start the requested work; the gate must finish before starting the requested work. Do not defer this until the final response.',
    'If the topic is genuinely uncertain or either required Codex App tool is unavailable, skip renaming without blocking the task. A short, simple, or immediately actionable request is not by itself uncertain.',
    'Use English TYPE codes by default. Use Chinese TYPE labels only when this first user request explicitly asks for Chinese labels.',
    'Change only the current main task title. Do not change any project name, content, project assignment, order, pin state, archive state, another task, or a sidebar-external subagent.',
    'Keep automatic naming silent: do not show a title preview, request confirmation, or add a rename report to the user response.',
    '',
    policy,
  ].join('\n');
}

module.exports = {
  automaticNamingGuidance,
  identityGuidance,
  loadTitlePolicy,
  validatedSessionId,
};
