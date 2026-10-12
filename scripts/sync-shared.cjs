#!/usr/bin/env node
'use strict';

// Each plugin is installed on its own and cannot import from a sibling plugin or from the repository root, so code
// that several plugins need lives once in shared/ and reaches every plugin as a generated copy in its own _shared/
// directory. CI runs this with --check, so an edit to a copy, or to the source without regenerating, fails.
// Usage: node scripts/sync-shared.cjs [--check] [repository-root]
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const check = args.includes('--check');
const root = path.resolve(args.find((arg) => !arg.startsWith('--')) || path.join(__dirname, '..'));
// Source file in shared/ -> the plugin directories that receive a copy.
const SHARED = {
  'python-candidates.cjs': ['dbg-codex/scripts', 'local-knowledge-codex/scripts'],
};

function generated(name) {
  const body = fs.readFileSync(path.join(root, 'shared', name), 'utf8').replace(/\r\n/g, '\n');
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  return `// GENERATED from shared/${name} (${hash}) by scripts/sync-shared.cjs. Do not edit: change the source and rerun it.\n${body}`;
}

const stale = [];
for (const [name, directories] of Object.entries(SHARED)) {
  const wanted = generated(name);
  for (const directory of directories) {
    const target = path.join(root, 'plugins', directory, '_shared', name);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
    if (current === wanted) continue;
    if (check) {
      stale.push(path.relative(root, target));
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, wanted);
      console.log(`wrote ${path.relative(root, target)}`);
    }
  }
}
if (check) {
  if (stale.length > 0) {
    console.error(`Stale generated copies:\n  ${stale.join('\n  ')}\nRun: node scripts/sync-shared.cjs`);
    process.exit(1);
  }
  console.log('sync-shared PASS');
}
