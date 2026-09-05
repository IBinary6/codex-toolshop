#!/usr/bin/env node
'use strict';

const { automaticNamingGuidance, identityGuidance } = require('./lib/guidance');
const { readStdinJson, writeHookContext } = require('./lib/protocol');

/**
 * 注入当前 task 身份；只有 startup 同时附带首条请求自动命名指令。
 *
 * @returns {void}
 * @example
 * main();
 */
function main() {
  const input = readStdinJson();
  const identity = identityGuidance(input);
  if (!input || !identity) return;

  let context = identity;
  if (input.source === 'startup' && process.env.PLUGIN_ROOT) {
    try {
      const automatic = automaticNamingGuidance(process.env.PLUGIN_ROOT, input);
      if (automatic) context = `${identity}\n\n${automatic}`;
    } catch (error) {
      process.stderr.write(`[conversation-namer-codex] SessionStart policy failed open: ${error.message}\n`);
    }
  }
  writeHookContext('SessionStart', context);
}

main();
