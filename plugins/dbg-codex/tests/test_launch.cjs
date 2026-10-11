'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { findPython, dataDir, runMcp } = require('../scripts/launch.cjs');

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

test('running MCP launcher and backend release plugin cache for parent-directory rename', async () => {
  assert.equal(typeof runMcp, 'function');
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-mcp-cwd-')));
  const plugin = path.join(temp, 'cache', 'dbg-codex');
  const version = path.join(plugin, '1.0', 'scripts');
  const data = path.join(temp, 'data');
  const launcherState = path.join(temp, 'launcher.json');
  const backendState = path.join(temp, 'backend.json');
  const stopFile = path.join(temp, 'stop');
  const backendScript = path.join(temp, 'backend.cjs');
  fs.mkdirSync(version, { recursive: true });
  fs.writeFileSync(backendScript, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(backendState)}+'.tmp',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));fs.renameSync(${JSON.stringify(backendState)}+'.tmp',${JSON.stringify(backendState)});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopFile)})){clearInterval(timer);process.exit(0)}},25);`);
  const code = `
    const fs=require('node:fs'),cp=require('node:child_process');
    const {runMcp}=require(${JSON.stringify(path.resolve(__dirname, '../scripts/launch.cjs'))});
    runMcp('x64dbg',{ensurePython:()=>[process.execPath],doctor:()=>({status:0}),spawn(command,args,opts){
      fs.writeFileSync(${JSON.stringify(launcherState)}+'.tmp',JSON.stringify({cwd:process.cwd(),command,args,childCwd:opts.cwd,home:process.env.DBG_HOME}));
      fs.renameSync(${JSON.stringify(launcherState)}+'.tmp',${JSON.stringify(launcherState)});
      return cp.spawn(process.execPath,[${JSON.stringify(backendScript)},...args],opts);
    }});
  `;
  const child = spawn(process.execPath, ['-e', code], {
    cwd: version, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, DBG_HOME: path.relative(version, data) },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  async function waitFor(file) {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(file)) {
      if (child.exitCode !== null) throw new Error(`launcher exited ${child.exitCode}: ${stderr}`);
      if (Date.now() > deadline) throw new Error(`timed out: ${file}; ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  try {
    const state = await waitFor(launcherState);
    const backend = await waitFor(backendState);
    assert.equal(state.cwd, data);
    assert.equal(state.home, data);
    assert.equal(state.childCwd, data);
    assert.equal(state.command, process.execPath);
    assert.equal(state.args[0], path.resolve(__dirname, '../scripts/managed_server.py'));
    assert.equal(state.args[1], 'x64dbg');
    assert.equal(backend.cwd, data);
    fs.renameSync(plugin, `${plugin}.backup`);
  } finally {
    fs.writeFileSync(stopFile, 'stop');
    let timeout;
    try {
      await Promise.race([
        new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`launcher did not stop: ${stderr}`)), 5000); }),
      ]);
    } finally { clearTimeout(timeout); }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
