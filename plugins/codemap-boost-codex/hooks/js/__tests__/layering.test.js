'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Hooks and their libraries are the lower layer; the launcher scripts under scripts/ are built on top of them.
// A library that required a script would make the two load each other and force lazy requires to break the cycle.
const hooksDir = path.resolve(__dirname, '..');
const sources = [
  ...fs.readdirSync(hooksDir).filter((name) => name.endsWith('.js')).map((name) => path.join(hooksDir, name)),
  ...fs.readdirSync(path.join(hooksDir, 'lib')).filter((name) => name.endsWith('.js')).map((name) => path.join(hooksDir, 'lib', name)),
];

const offenders = [];
for (const file of sources) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/require\(\s*['"]([^'"]*\/scripts\/[^'"]*)['"]\s*\)/g)) {
    offenders.push(`${path.relative(hooksDir, file)} requires ${match[1]}`);
  }
}
assert.deepEqual(offenders, [], 'hooks/js must not depend on scripts/');
console.log('layering.test.js PASS');
