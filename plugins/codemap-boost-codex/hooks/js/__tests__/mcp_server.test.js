'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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
    readBootstrapFailure: () => 'installer diagnostic',
  });
  assert.deepStrictEqual(prepared, { ok: false, diagnostic: 'installer diagnostic' });
}

async function discoveryOnly() {
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-node-discovery-')));
  const forbidden = path.join(data, 'prepare-called');
  const server = path.resolve(__dirname, '../../../scripts/mcp-server.cjs');
  const script = 'const fs=require("node:fs");require(process.argv[1]).runMcpServer({pluginDataDir:process.argv[2],prepareSpawn(){fs.writeFileSync(process.argv[3],"called");throw new Error("discovery must not prepare");}}).then(code=>process.exitCode=code);';
  const child = spawn(process.execPath, ['-e', script, server, data, forbidden], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    for (const [id, method, params] of [[1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }], [2, 'tools/list'], [3, 'prompts/list'], [4, 'ping']]) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    }
    const deadline = Date.now() + 5000;
    let responses;
    while (true) {
      responses = stdout.trim().split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
      if (responses.length === 4) break;
      if (Date.now() > deadline) throw new Error(`discovery timeout: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.strictEqual(responses.find((r) => r.id === 1).result.protocolVersion, '2025-03-26', 'supported host version must be preserved');
    assert.strictEqual(responses.find((r) => r.id === 2).result.tools.length, 30);
    assert.strictEqual(responses.find((r) => r.id === 3).result.prompts.length, 5);
    assert.strictEqual(fs.existsSync(forbidden), false);
    assert.strictEqual(fs.existsSync(path.join(data, 'crg-runtimes')), false, 'discovery cannot create/install runtime');
    child.stdin.end();
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.strictEqual(code, 0, stderr);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
}
discoveryOnly().then(() => console.log('mcp_server.test.js PASS')).catch((error) => { console.error(error); process.exitCode = 1; });
