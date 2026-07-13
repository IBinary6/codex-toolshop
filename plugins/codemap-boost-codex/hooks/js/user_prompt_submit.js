'use strict';

const { additionalContext, hookCwd, passSilent, readStdinJson } = require('./lib/runtime');
const { CONTEXT, isCodeMapEnabled, promptLooksStructural, refreshCrgSync } = require('./lib/codemap');

function promptText(input) {
  if (!input || typeof input !== 'object') return '';
  return input.prompt || input.user_prompt || input.message || input.text || '';
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  if (!isCodeMapEnabled() || !promptLooksStructural(promptText(input))) return passSilent();
  const refreshed = refreshCrgSync(hookCwd(input));
  const status = refreshed
    ? 'code-review-graph refresh completed for the current project.'
    : 'code-review-graph refresh did not complete; do not rely on stale graph results.';
  return additionalContext('UserPromptSubmit', `${status} ${CONTEXT}`);
}

main().catch(() => passSilent());
