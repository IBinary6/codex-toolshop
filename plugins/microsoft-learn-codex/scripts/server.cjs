#!/usr/bin/env node
'use strict';

const { Gateway, runStdio } = require('./gateway.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { SafeError, configPath } = require('./config.cjs');
const { researchToolsProvider: PROFILE } = require('../package.json');

function parseArgs(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--provider') return { provider: args[1] };
  throw new SafeError('The Research Tools entry point accepts only the --provider option.');
}

if (require.main === module) {
  if (Number(process.versions.node.split('.')[0]) < 20) process.exit(1);
  try {
    const options = parseArgs(process.argv.slice(2));
    const configFile = configPath(process.env, undefined, options.provider ?? PROFILE);
    // On Windows, a process cwd locks its directory. First switch to the stable runtime beside private configuration,
    // then create the gateway. Fetch children inherit this cwd, allowing the plugin cache to be replaced while running.
    const runtime = path.join(path.dirname(configFile), 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    process.chdir(runtime);
    const gateway = new Gateway({ ...options, configFile });
    const stdio = runStdio(gateway, { onClose: () => { process.exit(0); } });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stdio.close(); });
  } catch { process.exitCode = 1; }
}

module.exports = { parseArgs };
