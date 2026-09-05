#!/usr/bin/env node
'use strict';

const { identityGuidance } = require('./lib/guidance');
const { readStdinJson, writeHookContext } = require('./lib/protocol');
const { armSession } = require('./lib/state');
const { queueStartupObservation } = require('./startup_observer');

/**
 * 提供当前 task 身份，并为新会话登记一次待命名状态。
 *
 * @returns {void}
 * @example
 * main();
 */
function main(input = readStdinJson(), {
  env = process.env, observe = queueStartupObservation, writeContext = writeHookContext,
} = {}) {
  const identity = identityGuidance(input);
  if (!input || !identity) return;

  try {
    if (armSession(input, env)) observe(input.session_id, { env });
  } catch (_) {
    process.stderr.write('[conversation-namer-codex] Could not register automatic naming.\n');
  }
  writeContext('SessionStart', identity);
}

if (require.main === module) main();

module.exports = { main };
