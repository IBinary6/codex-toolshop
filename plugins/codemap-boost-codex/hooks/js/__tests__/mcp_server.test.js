'use strict';

const assert = require('node:assert');
const { prepareMcpServer } = require('../../../scripts/mcp-server.cjs');

{
  let enabled = false;
  const prepared = prepareMcpServer({
    ensureCrg: () => true,
    crgRuntimePaths: () => ({ command: '/plugin-data/crg-runtime/bin/code-review-graph' }),
    enableCodeMap: () => { enabled = true; },
  });
  assert.deepStrictEqual(prepared, {
    ok: true,
    command: '/plugin-data/crg-runtime/bin/code-review-graph',
    args: ['serve'],
  });
  assert.strictEqual(enabled, true, 'successful native MCP startup enables CodeMap hooks');
}

{
  const prepared = prepareMcpServer({
    ensureCrg: () => false,
    readBootstrapFailure: () => '安装器诊断',
  });
  assert.deepStrictEqual(prepared, { ok: false, diagnostic: '安装器诊断' });
}

console.log('mcp_server.test.js PASS');
