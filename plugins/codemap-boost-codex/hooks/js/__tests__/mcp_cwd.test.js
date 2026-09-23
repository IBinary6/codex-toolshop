'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const scripts = path.resolve(__dirname, '../../../scripts');

async function waitForFile(file, child) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(file)) {
    if (child.exitCode !== null) throw new Error(`launcher exited: ${child.exitCode}`);
    if (Date.now() > deadline) throw new Error(`timed out: ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function verifyLauncher(name, expression) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `codemap-${name}-cwd-`));
  const plugin = path.join(temp, 'cache', 'codemap-boost-codex');
  const version = path.join(plugin, '1.0', 'scripts');
  const backup = `${plugin}.backup`;
  const data = path.join(temp, 'data');
  const launcherState = path.join(temp, 'launcher.json');
  const backendState = path.join(temp, 'backend.json');
  const stopFile = path.join(temp, 'stop');
  const pythonPath = path.join(temp, 'tools', 'python.exe');
  const pythonSetting = name === 'crg' ? path.relative(version, pythonPath) : 'python3';
  fs.mkdirSync(version, { recursive: true });
  const fakeBackend = path.join(temp, 'backend.cjs');
  fs.writeFileSync(fakeBackend, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(backendState)}+'.tmp',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));fs.renameSync(${JSON.stringify(backendState)}+'.tmp',${JSON.stringify(backendState)});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopFile)})){clearInterval(timer);process.exit(0)}},25);`);
  const code = `
    const fs=require('node:fs'); const cp=require('node:child_process');
    const mod=require(${JSON.stringify(path.join(scripts, name === 'crg' ? 'mcp-server.cjs' : 'serena-server.cjs'))});
    const data=${JSON.stringify(data)}, state=${JSON.stringify(launcherState)}, backend=${JSON.stringify(fakeBackend)};
    const writeState=(value)=>{fs.writeFileSync(state+'.tmp',JSON.stringify(value));fs.renameSync(state+'.tmp',state)};
    ${expression}
  `;
  const child = spawn(process.execPath, ['-e', code], {
    cwd: version, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, PLUGIN_DATA: path.relative(version, data), CODEMAP_BOOST_PYTHON: pythonSetting },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const state = await waitForFile(launcherState, child).catch((error) => { throw new Error(`${error.message}; ${stderr}`); });
    const backend = await waitForFile(backendState, child).catch((error) => { throw new Error(`${error.message}; ${stderr}`); });
    assert.equal(state.cwd, data, `${name} launcher cwd; ${stderr}`);
    assert.equal(backend.cwd, data, `${name} backend cwd; ${stderr}`);
    assert.equal(state.childCwd, data);
    assert.equal(state.pluginData, data);
    assert.equal(state.python, name === 'crg' ? pythonPath : 'python3');
    assert.equal(state.command, process.execPath);
    assert.equal(state.args[0], name === 'crg' ? 'serve' : 'start-mcp-server');
    fs.renameSync(plugin, backup);
    assert.ok(fs.existsSync(backup));
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
}

(async () => {
  await verifyLauncher('crg', `mod.runMcpServer({ensureCrg:()=>true,enableCodeMap:()=>{},crgRuntimePaths:()=>({command:process.execPath}),scheduleRuntimeUpdates:()=>{},spawn(command,args,opts){writeState({cwd:process.cwd(),pluginData:process.env.PLUGIN_DATA,python:process.env.CODEMAP_BOOST_PYTHON,command,args,childCwd:opts.cwd});return cp.spawn(process.execPath,[backend,...args],opts);}});`);
  await verifyLauncher('serena', `mod.runSerenaServer({ensureSerena:()=>true,serenaRuntimePaths:()=>({command:process.execPath}),serenaLaunchEnv:()=>process.env,scheduleRuntimeUpdates:()=>{},spawn(command,args,opts){writeState({cwd:process.cwd(),pluginData:process.env.PLUGIN_DATA,python:process.env.CODEMAP_BOOST_PYTHON,command,args,childCwd:opts.cwd});return cp.spawn(process.execPath,[backend,...args],opts);}});`);
  console.log('mcp_cwd.test.js PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
