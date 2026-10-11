#!/usr/bin/env node
'use strict';

const { PROVIDERS, SafeError, configPath, readConfig, createConfig, profile } = require('./config.cjs');
const { researchToolsProvider: PACKAGE_PROFILE } = require('../package.json');

function main(args = process.argv.slice(2)) {
  let provider = PACKAGE_PROFILE;
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1] && provider === undefined) provider = args[++i];
    else if (['--doctor', '--help'].includes(args[i]) && !flags.includes(args[i])) flags.push(args[i]);
    else throw new SafeError('Supported options: --provider provider, --doctor, --help.');
  }
  const selected = profile(provider);
  if (args.includes('--help')) {
    console.log(`node scripts/setup.cjs [--doctor]\nBy default, creates CODEX_HOME/${selected ? selected.name : 'research-tools'}/config.json only if missing; doctor shows configuration status only.`);
    return;
  }
  const file = configPath(process.env, undefined, provider);
  if (!flags.includes('--doctor')) console.log(createConfig(file, provider) ? 'Created blank private configuration.' : 'Private configuration already exists; preserved its contents.');
  const config = readConfig(file, provider);
  console.log(`Configuration file: ${file}`);
  if (selected && !selected.key) console.log(`${selected.name}: no key required`);
  else for (const name of selected ? [provider] : PROVIDERS) console.log(`${name}: ${config[name].apiKey ? 'configured (redacted)' : name === 'context7' ? 'anonymous access' : 'key not configured'}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error instanceof SafeError ? error.message : 'Research Tools configuration check failed.'); process.exitCode = 1; }
}
module.exports = { main };
