'use strict';

const { additionalContext, passSilent, readStdinJson } = require('./lib/runtime');
const { CONTEXT, promptLooksStructural } = require('./lib/codemap');
const { resetSearchReminder } = require('./lib/search_reminder');

function promptText(input) {
  if (!input || typeof input !== 'object') return '';
  return input.prompt || input.user_prompt || input.message || input.text || '';
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  // Only removes the previous reminder's marker file: nothing is written, so no repository lookup is needed.
  resetSearchReminder(input);
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1'
    || !promptLooksStructural(promptText(input))) return passSilent();
  // Keywords only hint at available tools. The barrier refreshes on actual graph access without blocking pure consultation.
  return additionalContext('UserPromptSubmit', CONTEXT);
}

main().catch(() => passSilent());
