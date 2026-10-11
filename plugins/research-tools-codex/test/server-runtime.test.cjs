'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { generate } = require('../packaging/generate.cjs');
const { PROFILES } = require('../scripts/config.cjs');

function request(child, id, method, params) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => { clearTimeout(timer); child.stdout.removeListener('data', data); child.removeListener('error', fail); child.removeListener('exit', fail); };
    const fail = () => { cleanup(); reject(new Error('server exited before reply')); };
    const data = chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const value = JSON.parse(line); if (value.id === id) { cleanup(); resolve(value); } }
        catch (error) { cleanup(); reject(error); }
      }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('server reply timeout')); }, 10000);
    child.stdout.on('data', data); child.once('error', fail); child.once('exit', fail);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  });
}

function snapshot(directory, prefix = '') {
  const files = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false);
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, snapshot(path.join(directory, entry.name), name + '/'));
    else files[name] = fs.readFileSync(path.join(directory, entry.name)).toString('base64');
  }
  return files;
}

test('native Windows server releases plugin cache cwd before ping, preserves private paths and Fetch inherits runtime', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'research-server-runtime-'));
  let child, closed;
  try {
    generate({ outputRoot: path.join(temporary, 'packages') });
    const backend = path.join(temporary, 'fetch-fixture.cjs');
    fs.writeFileSync(backend, `
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (!Object.hasOwn(m, 'id')) return;
        const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} }
          : { content: [{ type: 'text', text: process.cwd() }], structuredContent: { cwd: process.cwd() } };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      });
    `);
    const guard = path.join(temporary, 'guard.cjs');
    fs.writeFileSync(guard, `
      globalThis.fetch = () => { throw new Error('forbidden real HTTP'); };
      const cp = require('node:child_process');
      const original = cp.spawn;
      cp.spawn = (command, args, options) => {
        if (command !== 'uvx') throw new Error('forbidden real backend');
        return original(process.execPath, [process.env.FIXTURE_BACKEND], options);
      };
    `);
    for (const provider of ['microsoft', 'fetch', 'sequentialthinking', undefined]) {
      const name = provider === undefined ? 'research-tools' : PROFILES[provider].name;
      const plugin = path.join(temporary, 'plugin-' + name);
      if (provider !== undefined) fs.cpSync(path.join(temporary, 'packages', name), plugin, { recursive: true });
      else {
        fs.mkdirSync(plugin);
        fs.cpSync(path.join(__dirname, '../scripts'), path.join(plugin, 'scripts'), { recursive: true });
        for (const file of ['package.json', 'config.example.json']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(plugin, file));
      }
      const before = snapshot(plugin);
      // Keep only startup environment variables; configuration/runtime remain in this test's private temporary directory.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT)$/i.test(key)));
      env.CODEX_HOME = path.join(temporary, 'private-home-' + name);
      env.FIXTURE_BACKEND = backend;
      const overridden = provider === 'microsoft' || provider === undefined;
      const config = overridden ? path.join(temporary, 'private-config-' + name, 'custom.json') : path.join(env.CODEX_HOME, name, 'config.json');
      if (overridden) env[provider === undefined ? 'RESEARCH_TOOLS_CONFIG' : PROFILES[provider].override] = config;
      const runtime = path.join(path.dirname(config), 'runtime');
      const args = ['--require', guard, path.join(plugin, 'scripts/server.cjs'), ...(provider === undefined ? [] : ['--provider', provider])];
      child = spawn(process.execPath, args, { cwd: plugin, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', bytes => { stderr += bytes; });
      closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      assert.deepEqual((await request(child, 1, 'ping')).result, {});
      assert.equal(fs.statSync(runtime).isDirectory(), true);
      assert.equal(fs.existsSync(config), true);
      const configBefore = fs.readFileSync(config);
      if (provider === 'fetch' || provider === undefined) {
        const result = (await request(child, 2, 'tools/call', { name: 'fetch', arguments: { url: 'https://synthetic.invalid' } })).result;
        assert.equal(result.isError, undefined);
        assert.equal(result.structuredContent.cwd, runtime);
      }
      assert.deepEqual(snapshot(plugin), before, 'server must not write into the plugin cache');
      const renamed = plugin + '-renamed';
      fs.renameSync(plugin, renamed);
      assert.equal(child.exitCode, null, 'rename is tested while the real server remains alive');
      assert.deepEqual((await request(child, 3, 'ping')).result, {});
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 10000);
      let result;
      try { result = await closed; } finally { clearTimeout(timer); }
      assert.deepEqual(result, { code: 0, signal: null }, 'EOF closes the server and owned backend');
      assert.equal(stderr, '');
      assert.deepEqual(fs.readFileSync(config), configBefore);
      assert.deepEqual(snapshot(renamed), before);
      child = undefined;
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
    const actual = fs.realpathSync(temporary);
    const relative = path.relative(fs.realpathSync(os.tmpdir()), actual);
    assert.ok(!path.isAbsolute(relative) && relative.startsWith('research-server-runtime-') && !relative.includes(path.sep));
    fs.rmSync(actual, { recursive: true, force: true });
  }
});
