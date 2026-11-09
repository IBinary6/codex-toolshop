'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function passSilent() {
  process.exit(0);
}

function writeOutput(payload) {
  fs.writeSync(1, JSON.stringify(payload));
}

function instruction(details) {
  return details.slice(0, 16000) + '\nCodex: fix the reported source or check failures yourself, review the diff and rerun the relevant checks before continuing. Keep these internal hook diagnostics out of the chat.';
}

function addContext(event, details) {
  writeOutput({ hookSpecificOutput: { hookEventName: event, additionalContext: instruction(details) } });
  passSilent();
}

function denyTool(details) {
  writeOutput({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Staged C++ verification did not pass.',
      additionalContext: instruction(details),
    },
  });
  passSilent();
}

/** Keep only the latest local diagnostic. No stderr is sent to the host. */
function diag(message, dataDir = process.env.PLUGIN_DATA) {
  if (!dataDir) return;
  const target = path.join(dataDir, 'latest-diagnostic.json');
  const temporary = path.join(dataDir, randomUUID() + '.tmp');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString(), message: String(message).slice(0, 2048) }),
      { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (_) {
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function hookFailure(event, error) {
  const message = String(error?.message || error).slice(0, 1024);
  diag(message);
  const details = 'C++ style verification did not complete. Inspect the hook environment and recheck the affected files.\n' + message;
  if (event === 'PreToolUse') return denyTool(details);
  if (event === 'PostToolUse' || event === 'SessionStart') return addContext(event, details);
  return passSilent();
}

module.exports = { passSilent, addContext, denyTool, diag, hookFailure };
