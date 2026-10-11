#!/usr/bin/env node
'use strict';

const { loadConfig, loadDefaults } = require('./lib/config');
const { toolNudge } = require('./lib/guidance');
const { hookCwd, readStdinJson, writeHookContext } = require('./lib/protocol');

function main() {
  const input = readStdinJson();
  if (!input) return;
  let config;
  try {
    config = loadConfig(hookCwd(input));
  } catch (_) {
    config = loadDefaults();
  }
  if (!config.modules.pre_tool_nudge) return;
  writeHookContext('PreToolUse', toolNudge(input, config));
}

main();
