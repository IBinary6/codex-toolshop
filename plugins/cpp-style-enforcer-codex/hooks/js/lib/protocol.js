'use strict';

/**
 * Single output channel: always exit 0; diagnostics go to stderr; stdout is empty or pure JSON.
 * Never exit 1 (issue #4809), or exit 2 with stdout JSON (a legacy crash cause).
 */

/** Silent pass: empty stdout/stderr and exit 0. */
function passSilent() {
  process.exit(0);
}

/**
 * Codex continuation feedback:exit 0 + stdout {decision:"block",reason}
 * @param {string} reason Repair instructions for Codex
 */
function blockCodex(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

/**
 * PreToolUse blocks a tool with exit 0 and stdout hookSpecificOutput.permissionDecision=deny.
 * @param {string} reason Reason for blocking
 */
function denyTool(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

/** Diagnostic visible to the user/Codex; never mix into stdout. */
function diag(message) {
  process.stderr.write(String(message) + '\n');
}

module.exports = { passSilent, blockCodex, denyTool, diag };
