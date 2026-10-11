'use strict';

const fs = require('fs');

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeHookContext(eventName, additionalContext) {
  if (!additionalContext) return;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  })}\n`);
}

function hookCwd(input) {
  return input && typeof input.cwd === 'string' && input.cwd
    ? input.cwd
    : process.cwd();
}

module.exports = { hookCwd, readStdinJson, writeHookContext };
