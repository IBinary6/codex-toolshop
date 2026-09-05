#!/usr/bin/env node
'use strict';

const { identityGuidance } = require('./lib/guidance');
const { readStdinJson, writeHookContext } = require('./lib/protocol');
const { armSession } = require('./lib/state');

/**
 * 提供当前 task 身份，并为新会话登记一次待命名状态。
 *
 * @returns {void}
 * @example
 * main();
 */
function main() {
  const input = readStdinJson();
  const identity = identityGuidance(input);
  if (!input || !identity) return;

  try {
    armSession(input);
  } catch (_) {
    process.stderr.write('[conversation-namer-codex] Could not register automatic naming.\n');
  }
  writeHookContext('SessionStart', identity);
}

main();
