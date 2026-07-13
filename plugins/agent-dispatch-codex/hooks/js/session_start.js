#!/usr/bin/env node
'use strict';

const { ensureConfigFiles, loadConfig, loadDefaults } = require('./lib/config');
const { ensureAgentProfiles } = require('./lib/agent_profiles');
const { mainAgentGuidance } = require('./lib/guidance');
const { hookCwd, readStdinJson, writeHookContext } = require('./lib/protocol');

function main() {
  const input = readStdinJson();
  const cwd = hookCwd(input);
  let config;
  try {
    ensureConfigFiles(cwd);
    config = loadConfig(cwd);
  } catch (error) {
    process.stderr.write(`[agent-dispatch-codex] SessionStart setup failed: ${error.message}\n`);
    config = loadDefaults();
  }
  try {
    ensureAgentProfiles(cwd, config);
  } catch (error) {
    process.stderr.write(`[agent-dispatch-codex] custom agent setup failed: ${error.message}\n`);
  }
  if (!config.modules.session_guidance) return;
  writeHookContext('SessionStart', mainAgentGuidance(config));
}

main();
