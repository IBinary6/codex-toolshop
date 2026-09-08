'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findPython, dataDir } = require('../scripts/launch.cjs');

test('an obsolete Python does not shadow a compatible interpreter', () => {
  const candidate = findPython({ platform: 'linux', env: {}, run(command) {
    return { status: 0, stdout: command === 'python3' ? '3.9\n' : '3.12\n' };
  } });
  assert.deepEqual(candidate, ['python']);
});

test('a missing interpreter is reported rather than assuming Python exists', () => {
  assert.equal(findPython({ platform: 'win32', env: {}, run: () => ({ status: 1 }) }), null);
});

test('CLI and plugin can share an explicitly chosen data directory', () => {
  assert.equal(dataDir({ DBG_HOME: '/tmp/dbg-test' }), path.resolve('/tmp/dbg-test'));
});

test('every bundled MCP uses the same script launcher with an independent backend', () => {
  const root = path.resolve(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.equal(Object.keys(config.mcpServers).length, 5);
  for (const entry of Object.values(config.mcpServers)) {
    assert.equal(entry.command, 'node');
    assert.equal(entry.args[0], 'scripts/launch.cjs');
    assert.equal(entry.args[1], 'mcp');
    assert.equal(entry.cwd, '.');
  }
});
