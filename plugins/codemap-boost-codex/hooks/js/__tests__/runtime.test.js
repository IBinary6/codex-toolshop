'use strict';

const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { MINIMUM_NODE_MAJOR, nodeRuntimeStatus, pluginDataDir } = require('../lib/runtime');

{
  assert.strictEqual(MINIMUM_NODE_MAJOR, 18);
  assert.deepStrictEqual(nodeRuntimeStatus('18.0.0'), {
    ok: true,
    version: '18.0.0',
    requirement: '>=18.0.0',
  });
  assert.strictEqual(nodeRuntimeStatus('17.9.1').ok, false, 'Node 17 is rejected');
  assert.strictEqual(nodeRuntimeStatus('not-a-version').ok, false, 'an unreadable Node version is rejected');
}

{
  const oldPluginData = process.env.PLUGIN_DATA;
  try {
    delete process.env.PLUGIN_DATA;
    const home = path.join(os.tmpdir(), 'codemap-qualified-home');
    const pluginRoot = path.join(
      home,
      'plugins',
      'cache',
      'codex-toolshop',
      'codemap-boost-codex',
      '0.1.19'
    );
    assert.strictEqual(
      pluginDataDir({ codexHome: home, pluginRoot }),
      path.join(home, 'plugins', 'data', 'codemap-boost-codex-codex-toolshop'),
      'direct setup and native MCP must use the same marketplace-qualified data directory as hooks'
    );
  } finally {
    if (oldPluginData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = oldPluginData;
  }
}

console.log('runtime.test.js PASS');
