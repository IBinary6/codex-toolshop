#!/usr/bin/env node
'use strict';

const { loadConfig, loadDefaults } = require('./lib/config');
const { mainAgentGuidance, promptNeedsDispatch } = require('./lib/guidance');
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
  if (!config.modules.prompt_guidance || !promptNeedsDispatch(input.prompt, config)) return;
  writeHookContext('UserPromptSubmit', mainAgentGuidance(config, true));
}

main();
