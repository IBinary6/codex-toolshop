'use strict';

const { additionalContext, passSilent, readStdinJson } = require('./lib/runtime');
const { CONTEXT, bashLooksLikeCodeSearch, isCodeMapEnabled } = require('./lib/codemap');

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  const command = input && input.tool_input && input.tool_input.command;
  if (!isCodeMapEnabled() || !bashLooksLikeCodeSearch(command)) return passSilent();
  return additionalContext('PreToolUse', CONTEXT);
}

main().catch(() => passSilent());
