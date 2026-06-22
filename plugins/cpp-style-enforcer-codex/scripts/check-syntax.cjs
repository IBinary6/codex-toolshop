'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const targets = [
  'scripts',
  'hooks/js',
];

function collectJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJs(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    } else if (entry.isFile() && entry.name.endsWith('.cjs')) {
      out.push(full);
    }
  }
  return out;
}

const files = targets.flatMap((rel) => collectJs(path.join(root, rel)));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${file} syntax check failed\n`);
    process.exit(result.status || 1);
  }
}
