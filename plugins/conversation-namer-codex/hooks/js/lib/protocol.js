'use strict';

const fs = require('fs');

/**
 * Read one Codex hook JSON object from stdin; fail open on invalid input.
 *
 * @returns {object|null} Parsed object, or null.
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
 * Emit additional developer context using the Codex JSONL protocol.
 *
 * @param {string} eventName Hook event name.
 * @param {string} additionalContext Context to inject.
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
