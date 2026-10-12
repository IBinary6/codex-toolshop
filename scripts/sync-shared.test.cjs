#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, 'sync-shared.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-shared-'));
const source = path.join(root, 'shared', 'python-candidates.cjs');
const copies = ['dbg-codex', 'local-knowledge-codex'].map((plugin) => path.join(root, 'plugins', plugin, 'scripts', '_shared', 'python-candidates.cjs'));
const run = (...args) => spawnSync(process.execPath, [script, ...args, root], { encoding: 'utf8' });

try {
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "'use strict';\nmodule.exports = { version: 1 };\n");
  assert.equal(run('--check').status, 1, 'missing copies are reported');
  assert.match(run('--check').stderr, /dbg-codex[\s\S]*local-knowledge-codex/);

  assert.equal(run().status, 0);
  for (const copy of copies) {
    const text = fs.readFileSync(copy, 'utf8');
    assert.match(text, /^\/\/ GENERATED from shared\/python-candidates\.cjs \([0-9a-f]{12}\) by scripts\/sync-shared\.cjs\. Do not edit/);
    assert.ok(text.endsWith("module.exports = { version: 1 };\n"));
  }
  assert.equal(run('--check').status, 0, 'fresh copies pass');

  fs.appendFileSync(copies[0], '// hand edit\n');
  const edited = run('--check');
  assert.equal(edited.status, 1, 'an edited copy fails');
  assert.match(edited.stderr, /dbg-codex/);
  assert.doesNotMatch(edited.stderr, /local-knowledge-codex/, 'only the edited copy is named');
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0, 'regenerating discards the hand edit');

  fs.writeFileSync(source, "'use strict';\nmodule.exports = { version: 2 };\n");
  assert.equal(run('--check').status, 1, 'a changed source without regenerating fails');
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);

  fs.writeFileSync(copies[1], fs.readFileSync(copies[1], 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(run('--check').status, 0, 'line endings do not matter: git normalizes them differently per platform');
  console.log('sync-shared.test.cjs PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
