'use strict';

const fs = require('fs');
const {
  detectPython,
  renderRecall,
  resultItems,
  runCli,
  workspaceScopeArgs,
} = require('./local_knowledge_cli');

function emit(additionalContext) {
  /** Emit additional context for Codex SessionStart. */
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
}

function main() {
  /** Check the runtime and load persistent knowledge for the current scope at session start. */
  let input = null;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) {}
  const detected = detectPython();
  if (!detected.ok) {
    const where = detected.version
      ? `detected Python ${detected.version} (below 3.11)`
      : 'no usable Python was found';
    emit(`[LOCAL_KNOWLEDGE_SETUP_HINT] Local Knowledge requires Python 3.11+; currently ${where}.`
      + 'Run the local-knowledge-setup skill to check the environment; recall failure does not block other work.');
    return;
  }

  const data = runCli(['recall', '--occasion', 'session_start',
    ...workspaceScopeArgs(input), '--no-legacy-bugs', '--limit', '5', '--max-chars', '2500']);
  const items = resultItems(data);
  if (items.length > 0) emit(renderRecall(items, 'session_start'));
}

try { main(); } catch (_) {}
