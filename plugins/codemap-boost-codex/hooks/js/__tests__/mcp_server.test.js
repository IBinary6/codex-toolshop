'use strict';

const assert = require('node:assert');
const { prepareMcpServer } = require('../../../scripts/mcp-server.cjs');

{
  let ensured = false;
  const prepared = prepareMcpServer({
    nodeRuntimeStatus: () => ({ ok: false, version: '16.20.2', requirement: '>=18.0.0' }),
    ensureCrg: () => { ensured = true; return true; },
  });
  assert.strictEqual(prepared.ok, false);
  assert.match(prepared.diagnostic, /Node\.js 16\.20\.2.*>=18\.0\.0/);
  assert.strictEqual(ensured, false, 'unsupported Node must fail before runtime installation');
}

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
