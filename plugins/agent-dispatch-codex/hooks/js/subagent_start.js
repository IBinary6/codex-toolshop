#!/usr/bin/env node
'use strict';

const { loadConfig, loadDefaults } = require('./lib/config');
const { subagentGuidance } = require('./lib/guidance');
const { hookCwd, readStdinJson, writeHookContext } = require('./lib/protocol');

function main(input = readStdinJson()) {
  let config;
  try {
    config = loadConfig(hookCwd(input));
  } catch (_) {
    config = loadDefaults();
  }
  if (!config.modules.subagent_guidance) return;
  writeHookContext('SubagentStart', subagentGuidance(config));
}

if (require.main === module) main();

module.exports = { main };
