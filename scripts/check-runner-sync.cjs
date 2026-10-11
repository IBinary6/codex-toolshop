#!/usr/bin/env node
'use strict';

// The fail-open hook runners each carry the same runInProcess function, because a plugin is installed on its own
// and cannot import from a sibling plugin. This check fails when one copy is edited without the others.
// Usage: node scripts/check-runner-sync.cjs [repository-root]
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const PLUGINS = ['agent-dispatch-codex', 'codemap-boost-codex', 'conversation-namer-codex', 'local-knowledge-codex'];
const FUNCTION_TEXT = /function runInProcess\([\s\S]*?\n}\n/;

const copies = PLUGINS.map((plugin) => {
  const file = path.join(root, 'plugins', plugin, 'scripts', 'run-hook.cjs');
  const match = FUNCTION_TEXT.exec(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  if (!match) throw new Error(`${plugin}: runInProcess not found in scripts/run-hook.cjs`);
  return { plugin, text: match[0] };
});

const [reference, ...others] = copies;
const drifted = others.filter((copy) => copy.text !== reference.text);
if (drifted.length > 0) {
  console.error(`runInProcess differs from the copy in ${reference.plugin}: ${drifted.map((copy) => copy.plugin).join(', ')}`);
  console.error('These copies are meant to be identical; apply every edit to all of them.');
  process.exit(1);
}
console.log(`check-runner-sync PASS (${copies.length} identical copies)`);
