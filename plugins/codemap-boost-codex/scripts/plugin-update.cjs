'use strict';
const { checkPluginUpdates, readState } = require('../hooks/js/lib/plugin-updates');
const arg = process.argv[2];
if (process.argv.length !== 3 || !['--doctor', '--check-now', '--scheduled'].includes(arg)) {
  process.stderr.write('Usage: node plugin-update.cjs --doctor|--check-now\n');
  process.exitCode = 2;
} else {
  const result = arg === '--doctor' ? readState() : checkPluginUpdates();
  if (arg !== '--scheduled') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'failed' ? 1 : 0;
}
