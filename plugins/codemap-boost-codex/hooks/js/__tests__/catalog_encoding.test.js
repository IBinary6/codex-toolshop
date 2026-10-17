'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptsDir = path.join(__dirname, '../../../scripts');

// Every bundled catalog must be strict UTF-8 (a raw cp1252 0x97 em-dash byte once slipped in) without replacement characters.
const bundled = fs.readdirSync(scriptsDir).filter((name) => /^mcp-catalog-.+\.json$/.test(name));
assert.ok(bundled.length > 0, 'at least one bundled MCP catalog expected');
for (const name of bundled) {
  const bytes = fs.readFileSync(path.join(scriptsDir, name));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (error) { assert.fail(`${name} is not valid UTF-8: ${error.message}`); }
  assert.equal(text.includes('�'), false, `${name} contains U+FFFD`);
  assert.doesNotThrow(() => JSON.parse(text), `${name} must be valid JSON`);
}

// Exporter output must be ASCII JSON under legacy Windows code pages; the stdlib-only Python test uses stub packages.
function findPython() {
  const candidates = [process.env.CODEMAP_TEST_PYTHON, 'python3', 'python'].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return '';
}

const python = findPython();
assert.ok(python, 'catalog exporter encoding test requires Python 3.8+ on PATH (or CODEMAP_TEST_PYTHON)');
const result = spawnSync(python, ['-I', '-B', path.join(__dirname, 'test_export_mcp_catalog.py')], { encoding: 'utf8', timeout: 60000 });
assert.equal(result.status, 0, `exporter encoding test failed:\n${result.stdout}\n${result.stderr}`);

console.log(`catalog_encoding.test.js PASS: ${bundled.length} bundled catalog(s) strict UTF-8; exporter output is ASCII JSON`);
