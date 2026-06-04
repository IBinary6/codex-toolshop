'use strict';

const { additionalContext, passSilent, readStdinJson } = require('./lib/runtime');
const { CONTEXT, canUseCrg, isCodeMapEnabled, promptLooksStructural } = require('./lib/codemap');

function promptText(input) {
  if (!input || typeof input !== 'object') return '';
  return input.prompt || input.user_prompt || input.message || input.text || '';
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  if (!isCodeMapEnabled() || !canUseCrg() || !promptLooksStructural(promptText(input))) return passSilent();
  return additionalContext('UserPromptSubmit', CONTEXT);
}

main().catch(() => passSilent());
