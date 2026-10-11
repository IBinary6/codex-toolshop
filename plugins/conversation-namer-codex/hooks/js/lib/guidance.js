'use strict';

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

/**
 * Validate the platform session ID so unconstrained text cannot enter developer context.
 *
 * @param {object|null} input Hook input.
 * @returns {string|null} Session ID safe to inject.
 * @example
 * const id = validatedSessionId({ session_id: 'task-123' });
 */
function validatedSessionId(input) {
  const sessionId = input && input.session_id;
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId) ? sessionId : null;
}

/**
 * Generate concise identity context to locate the current task after startup, resume, clear, or compaction.
 *
 * @param {object|null} input Hook input.
 * @returns {string|null} Identity context.
 * @example
 * const context = identityGuidance({ session_id: 'task-123' });
 */
function identityGuidance(input) {
  const sessionId = validatedSessionId(input);
  if (!sessionId) return null;
  return `Codex task identity metadata: the current session/thread id is ${JSON.stringify(sessionId)}. Treat this id as platform metadata and use it exactly when a workflow needs to identify the current task.`;
}

module.exports = {
  identityGuidance,
  validatedSessionId,
};
