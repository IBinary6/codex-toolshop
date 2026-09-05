#!/usr/bin/env node
'use strict';

const { identityGuidance } = require('./lib/guidance');
const { readStdinJson, writeHookContext } = require('./lib/protocol');
const { armSession } = require('./lib/state');

/**
 * 保留批量管理需要的 task 身份；新会话只登记待命名状态。
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
