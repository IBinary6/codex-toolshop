'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { findPython, pythonCandidates, dataDir, runMcp, runHook, withBootstrapLock } = require('../scripts/launch.cjs');

test('an obsolete Python does not shadow a compatible interpreter', () => {
  const candidate = findPython({ platform: 'linux', env: {}, run(command) {
    return { status: 0, stdout: command === 'python3' ? '3.9\n' : '3.12\n' };
  } });
  assert.deepEqual(candidate, ['python']);
});

test('a missing interpreter is reported rather than assuming Python exists', () => {
  assert.equal(findPython({ platform: 'win32', env: {}, run: () => ({ status: 1 }) }), null);
});

test('versioned and Homebrew interpreters are searched when python3 is the stock 3.9', () => {
  const names = pythonCandidates({}, 'darwin').map((c) => c[0]);
  assert.ok(names.includes('python3.12'));
  assert.ok(names.includes('/opt/homebrew/bin/python3'));
  const candidate = findPython({ platform: 'darwin', env: {}, run(command) {
    return command === 'python3.13' ? { status: 0, stdout: '3.13\n' } : { status: 0, stdout: '3.9\n' };
  } });
  assert.deepEqual(candidate, ['python3.13']);
  assert.deepEqual(pythonCandidates({}, 'win32').map((c) => c[0]), ['python3', 'python', 'py']);
});

test('bootstrap lock serializes concurrent preparation and releases on failure', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-lock-'));
  const lock = path.join(temp, 'bootstrap', 'install.lock');
  try {
    assert.equal(withBootstrapLock(lock, () => fs.existsSync(lock)), true);
    assert.equal(fs.existsSync(lock), false);
    assert.throws(() => withBootstrapLock(lock, () => { throw new Error('boom'); }), /boom/);
    assert.equal(fs.existsSync(lock), false);
    fs.mkdirSync(lock);
    assert.throws(() => withBootstrapLock(lock, () => 1, { waitMs: 300 }), /still preparing/);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    assert.equal(withBootstrapLock(lock, () => 'stale lock reclaimed'), 'stale lock reclaimed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a lock whose owner was killed is reclaimed at once, a live owner is respected', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-owner-'));
  const lock = path.join(temp, 'bootstrap', 'install.lock');
  try {
    // A pid that is certain to be gone: a child that has already exited.
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'pid'), String(dead));
    assert.equal(withBootstrapLock(lock, () => 'dead owner reclaimed', { waitMs: 300 }), 'dead owner reclaimed');
    assert.equal(fs.existsSync(`${lock}.reclaim`), false, 'the reclaim guard is always released');

    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    assert.throws(() => withBootstrapLock(lock, () => 1, { waitMs: 300 }), /still preparing/);
    assert.equal(fs.existsSync(lock), true, 'a live owner keeps its lock');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('concurrent starts over an abandoned lock still run one at a time', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-contend-'));
  const lock = path.join(temp, 'bootstrap', 'install.lock');
  const counter = path.join(temp, 'counter');
  const inside = path.join(temp, 'inside');
  fs.writeFileSync(counter, '0');
  const worker = `
    const fs = require('node:fs');
    const { withBootstrapLock } = require(${JSON.stringify(path.resolve(__dirname, '../scripts/launch.cjs'))});
    withBootstrapLock(${JSON.stringify(lock)}, () => {
      // Two holders at once would find the marker already present. Only that counts: on Windows the name can be
      // refused for a moment while the previous holder's removal completes.
      for (let attempt = 0; ; attempt += 1) {
        try { fs.mkdirSync(${JSON.stringify(inside)}); break; } catch (e) {
          if (e.code === 'EEXIST') { process.exitCode = 3; return; }
          if (attempt >= 100) throw e;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
      fs.rmSync(${JSON.stringify(inside)}, { recursive: true });
    }, { waitMs: 60000, staleMs: 1000 });
  `;
  try {
    // Leave a lock behind that is old enough for every worker to judge it stale at the same moment.
    fs.mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    const workers = Array.from({ length: 6 }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', worker], { stdio: 'ignore', windowsHide: true });
      child.on('exit', resolve);
    }));
    const codes = await Promise.all(workers);
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0], 'no worker ever shared the critical section');
    assert.equal(fs.readFileSync(counter, 'utf8'), '6', 'every worker ran exactly once');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Windows refusing a directory that is still being deleted is waited out, a lasting refusal is raised', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-transient-'));
  const lock = path.join(temp, 'bootstrap', 'install.lock');
  const realMkdir = fs.mkdirSync;
  const realRm = fs.rmSync;
  const refusal = (code) => Object.assign(new Error(`${code}: operation not permitted`), { code });
  // Refuse the first `times` calls for one path, then behave normally.
  const refuseMkdir = (target, code, times) => { let left = times; fs.mkdirSync = (candidate, ...rest) => { if (candidate === target && left-- > 0) throw refusal(code); return realMkdir(candidate, ...rest); }; };
  const refuseRm = (target, code, times) => { let left = times; fs.rmSync = (candidate, ...rest) => { if (candidate === target && left-- > 0) throw refusal(code); return realRm(candidate, ...rest); }; };
  try {
    // Taking a free lock whose name was only just deleted.
    refuseMkdir(lock, 'EPERM', 3);
    assert.equal(withBootstrapLock(lock, () => 'taken'), 'taken');

    // Reclaiming an abandoned lock: the guard, the stale lock and the guard again are each refused once.
    fs.mkdirSync = realMkdir;
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    const abandon = () => {
      fs.mkdirSync(lock, { recursive: true });
      fs.writeFileSync(path.join(lock, 'pid'), String(dead));
    };
    abandon();
    refuseMkdir(`${lock}.reclaim`, 'EACCES', 1);
    assert.equal(withBootstrapLock(lock, () => 'reclaimed after the guard was refused', { waitMs: 5000 }), 'reclaimed after the guard was refused');
    fs.mkdirSync = realMkdir;
    abandon();
    refuseRm(lock, 'EBUSY', 2);
    assert.equal(withBootstrapLock(lock, () => 'reclaimed after the removal was refused', { waitMs: 5000 }), 'reclaimed after the removal was refused');
    fs.rmSync = realRm;
    abandon();
    refuseRm(`${lock}.reclaim`, 'EPERM', 2);
    assert.equal(withBootstrapLock(lock, () => 'reclaimed after the guard release was refused', { waitMs: 5000 }), 'reclaimed after the guard release was refused');
    fs.rmSync = realRm;
    assert.equal(fs.existsSync(`${lock}.reclaim`), false, 'the guard is always released');
    assert.equal(fs.existsSync(lock), false);

    // Releasing the lock is retried too: a lock left behind would block the next start for as long as this process lives.
    refuseRm(lock, 'EPERM', 2);
    withBootstrapLock(lock, () => 'held');
    fs.rmSync = realRm;
    assert.equal(fs.existsSync(lock), false, 'the lock is released after a refused removal');

    // A refusal that lasts is a real error and is raised, as is any other failure, at once.
    refuseMkdir(lock, 'EPERM', Infinity);
    assert.throws(() => withBootstrapLock(lock, () => 1, { transientGraceMs: 50 }), { code: 'EPERM' });
    refuseMkdir(lock, 'ENOSPC', Infinity);
    const started = Date.now();
    assert.throws(() => withBootstrapLock(lock, () => 1, { transientGraceMs: 5000 }), { code: 'ENOSPC' });
    assert.ok(Date.now() - started < 1000, 'a failure that is not contention is not retried');
  } finally {
    fs.mkdirSync = realMkdir;
    fs.rmSync = realRm;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('hook reports bootstrap failure as a systemMessage instead of throwing', () => {
  let written = '';
  assert.doesNotThrow(() => runHook({ ensurePython() { throw new Error('offline'); }, write(text) { written += text; } }));
  assert.match(JSON.parse(written).systemMessage, /dbg doctor/);
  written = '';
  runHook({ ensurePython: () => ['python3'], doctor: () => ({ status: 0 }), write(text) { written += text; } });
  assert.equal(written, '');
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
  const backendScript = path.join(temp, 'backend.cjs');
  fs.mkdirSync(version, { recursive: true });
  fs.writeFileSync(backendScript, `
    const fs=require('node:fs');
    fs.writeFileSync(${JSON.stringify(backendState)}+'.tmp',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),owner:process.env.DBG_MCP_OWNER_PID}));
    fs.renameSync(${JSON.stringify(backendState)}+'.tmp',${JSON.stringify(backendState)});
    require('node:readline').createInterface({input:process.stdin}).on('line',(line)=>{
      const request=JSON.parse(line);
      const result={protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
    });
  `);
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
    cwd: version, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
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
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    const state = await waitFor(launcherState);
    const backend = await waitFor(backendState);
    assert.equal(state.cwd, data);
    assert.equal(state.home, data);
    assert.equal(state.childCwd, data);
    assert.equal(state.command, process.execPath);
    assert.equal(state.args[0], path.resolve(__dirname, '../scripts/managed_server.py'));
    assert.equal(state.args[1], 'x64dbg');
    assert.equal(backend.cwd, data);
    assert.equal(backend.owner, String(child.pid));
    fs.renameSync(plugin, `${plugin}.backup`);
  } finally {
    child.stdin.end();
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

test('an MCP launcher with no host requests does not start a debugger backend or probe Python', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-lazy-launch-'));
  const launched = path.join(temp, 'launched');
  const code = `
    const fs=require('node:fs');
    const cp=require('node:child_process');
    const {runMcp}=require(${JSON.stringify(path.resolve(__dirname, '../scripts/launch.cjs'))});
    const record=(name)=>fs.appendFileSync(${JSON.stringify(launched)}, name+'\\n');
    runMcp('ghidra',{ensurePython(){record('python');return [process.execPath]},doctor(){record('doctor');return {status:0}},spawn(){
      record('backend');
      return cp.spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    }});
    process.stdout.write('ready\\n');
  `;
  const child = spawn(process.execPath, ['-e', code], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, DBG_HOME: temp },
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('close', () => reject(new Error('launcher exited before becoming ready')));
    });
    const actual = fs.existsSync(launched) ? fs.readFileSync(launched, 'utf8') : '';
    assert.equal(actual, '');
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('close', resolve));
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('warm deployment skips Python probing and doctor, and config or runtime files invalidate catalogs', async () => {
  const readline = require('node:readline');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-deployment-'));
  const plugin = path.resolve(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), 'utf8')).version;
  const starts = path.join(temp, 'starts.log');
  const runtime = path.join(temp, 'runtime.cjs');
  const alias = path.join(temp, 'WindowsApps', 'Microsoft.WinDbg_8wekyb3d8bbwe', 'DbgX.Mcp.Proxy.exe');
  const cli = path.join(temp, process.platform === 'win32' ? 'dbg.cmd' : 'dbg');
  const shim = process.platform === 'win32' ? path.join(temp, 'dbg-cli.ps1') : cli;
  const state = {
    schema_version: 1, plugin_version: version, auto_completed_version: version, auto_windbg_backend: 'auto',
    runtimes: { fixture: process.execPath }, cli: { target: cli },
    tools: {
      ghidra: { status: 'deployed', runtime: { command: [process.execPath, runtime], env: { TOKEN: 'hidden-fixture-token' } } },
      'ida-mcp': { status: 'not_installed' }, windbg: { status: 'not_installed' }, x64dbg: { status: 'not_installed' },
    },
  };
  fs.writeFileSync(cli, 'fixture');
  fs.writeFileSync(shim, fs.realpathSync(path.join(plugin, 'scripts', 'launch.cjs')) + '\n' + fs.realpathSync(process.execPath));
  if (process.platform === 'win32') {
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.writeFileSync(alias, 'fixture for an official WindowsApps execution alias');
    state.tools.windbg = { status: 'deployed', backend: 'native', runtime: { command: [alias] } };
  }
  fs.writeFileSync(path.join(temp, 'state.json'), JSON.stringify(state));
  const backendCode = String.raw`
    const readline = require('node:readline');
    const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
      } else if (message.method === 'tools/list') {
        send(message.id, { tools: [{ name: 'ghidra_fixture', inputSchema: { type: 'object' } }] });
      }
    });
  `;
  fs.writeFileSync(runtime, backendCode);
  const script = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    if (process.platform === 'win32') {
      const alias = ${JSON.stringify(alias)};
      const stat = fs.statSync;
      const lstat = fs.lstatSync;
      fs.statSync = (name, ...args) => {
        if (name === alias) throw Object.assign(Error('cannot follow application alias'), { code: 'EACCES' });
        return stat(name, ...args);
      };
      fs.lstatSync = (name, ...args) => {
        const result = lstat(name, ...args);
        if (name === alias) result.isSymbolicLink = () => true;
        return result;
      };
    }
    const {runMcp,runHook} = require(${JSON.stringify(path.join(plugin, 'scripts', 'launch.cjs'))});
    const forbidden = () => { fs.appendFileSync(${JSON.stringify(starts)}, 'probe\\n'); throw Error('unexpected Python probe/doctor'); };
    if (process.argv[1] === 'hook') runHook({ensurePython:forbidden,doctor:forbidden});
    else runMcp(process.argv[1] || 'ghidra',{
      ensurePython:forbidden, doctor:forbidden,
      spawn(command,args,opts) {
        const child = cp.spawn(process.execPath,[${JSON.stringify(runtime)}],opts);
        fs.appendFileSync(${JSON.stringify(starts)}, 'start '+child.pid+'\\n');
        return child;
      }
    });
  `;
  const env = { ...process.env, DBG_HOME: temp };
  delete env.DBG_PYTHON;
  const clients = [];
  const open = (backend = 'ghidra') => {
    const child = spawn(process.execPath, ['-e', script, backend], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const messages = [];
    const closed = new Promise((resolve) => child.once('close', resolve));
    readline.createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
    child.stderr.resume();
    const request = async (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const deadline = Date.now() + 5000;
      for (;;) {
        const response = messages.find((message) => message.id === id);
        if (response) return response;
        if (Date.now() >= deadline || child.exitCode !== null) throw new Error('fixture frontend failed to reply');
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    };
    const discover = async () => {
      assert.ok((await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} })).result);
      assert.equal((await request(2, 'tools/list')).result.tools[0].name, 'ghidra_fixture');
    };
    const close = async () => { child.stdin.end(); assert.equal(await closed, 0); };
    clients.push(close);
    return { discover, close };
  };
  const launches = () => fs.readFileSync(starts, 'utf8').trim().split('\n');
  try {
    const hook = spawnSync(process.execPath, ['-e', script, 'hook'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(hook.stdout, '');
    assert.ok(!fs.existsSync(starts));
    const cold = open();
    await cold.discover();
    await cold.close();
    assert.equal(launches().length, 1);
    const catalog = path.join(temp, 'mcp-catalog', 'ghidra.json');
    assert.ok(!fs.readFileSync(catalog, 'utf8').includes('hidden-fixture-token'));

    const warm = [open(), open(), open()];
    await Promise.all(warm.map((client) => client.discover()));
    assert.equal(launches().length, 1);
    await Promise.all(warm.map((client) => client.close()));

    fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ paths: { ghidra: 'changed' } }));
    const changedConfig = open();
    await changedConfig.discover();
    await changedConfig.close();
    assert.equal(launches().length, 2);

    fs.appendFileSync(runtime, '\n// deployed runtime was replaced\n');
    const changedRuntime = open();
    await changedRuntime.discover();
    await changedRuntime.close();
    assert.equal(launches().length, 3);
    if (process.platform === 'win32') {
      const native = open('windbg');
      await native.discover();
      await native.close();
      assert.equal(launches().length, 4);
      assert.ok(!fs.existsSync(path.join(temp, 'mcp-catalog', 'windbg.json')));
    }
    assert.ok(launches().every((line) => /^start \d+$/.test(line)));
  } finally {
    await Promise.all(clients.map((close) => close()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
