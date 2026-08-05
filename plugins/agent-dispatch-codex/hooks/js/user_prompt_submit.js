#!/usr/bin/env node
'use strict';

const { loadConfig, loadDefaults } = require('./lib/config');
const { promptGuidance } = require('./lib/guidance');
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
  if (!config.modules.prompt_guidance) return;
  const guidance = promptGuidance(input.prompt, config);
  if (!guidance) return;
  writeHookContext('UserPromptSubmit', guidance);
}

main();
