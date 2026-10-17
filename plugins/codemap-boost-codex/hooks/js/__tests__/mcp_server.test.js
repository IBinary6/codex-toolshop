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
  // An installed runtime whose version exactly matches the bundled catalog is described without starting Python or the backend.
  const packageDir = path.join(data, 'crg-runtime', 'Lib', 'site-packages', 'code_review_graph-2.3.9.dist-info');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'METADATA'), 'Name: code-review-graph\nVersion: 2.3.9\n');
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
    assert.strictEqual(fs.existsSync(path.join(data, 'mcp-catalogs')), false, 'an exact bundled match needs no exported cache');
    child.stdin.end();
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.strictEqual(code, 0, stderr);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
}
// A fresh install has no installed version to match, so discovery must start the backend (which installs the latest CRG).
async function freshBackendDiscovery() {
  const { runMcpServer } = require('../../../scripts/mcp-server.cjs');
  const { PassThrough } = require('node:stream');
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-fresh-discovery-')));
  const input = new PassThrough(), output = new PassThrough(), stderr = new PassThrough();
  let prepared = 0, out = '';
  output.on('data', (chunk) => { out += chunk; });
  // runMcpServer chdirs into the data dir; Windows cannot remove a directory that is the process cwd.
  const originalCwd = process.cwd();
  try {
    const completion = runMcpServer({ pluginDataDir: data, input, output, stderr, prepareBackend: async () => { prepared++; throw new Error('backend preparation reached'); } });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } })}\n`);
    const deadline = Date.now() + 5000;
    while (!out.includes('\n')) {
      if (Date.now() > deadline) throw new Error('fresh discovery timeout');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.strictEqual(prepared, 1, 'fresh discovery starts backend preparation instead of serving a bundled 2.3.9 catalog');
    assert.match(JSON.parse(out.trim().split('\n')[0]).error.message, /backend preparation reached/);
    input.end(); await completion;
  } finally { process.chdir(originalCwd); fs.rmSync(data, { recursive: true, force: true }); }
}
discoveryOnly().then(freshBackendDiscovery).then(() => console.log('mcp_server.test.js PASS')).catch((error) => { console.error(error); process.exitCode = 1; });
