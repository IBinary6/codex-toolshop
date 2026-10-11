'use strict';

const { additionalContext, hookCwd, passSilent, readStdinJson, repoRoot } = require('./lib/runtime');
const { CONTEXT, promptLooksStructural } = require('./lib/codemap');
const { resetSearchReminder } = require('./lib/search_reminder');

function promptText(input) {
  if (!input || typeof input !== 'object') return '';
  return input.prompt || input.user_prompt || input.message || input.text || '';
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  const root = repoRoot(hookCwd(input));
  // Outside Git, do not write reminder state; structural requests can still receive discovery and fallback guidance.
  if (root) resetSearchReminder(input);
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1'
    || !promptLooksStructural(promptText(input))) return passSilent();
  // Keywords only hint at available tools. The barrier refreshes on actual graph access without blocking pure consultation.
  return additionalContext('UserPromptSubmit', CONTEXT);
}

main().catch(() => passSilent());
