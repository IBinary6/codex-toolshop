#!/usr/bin/env node
'use strict';

// Plugin, terminal, and MCP share this entry point; scripts make all installation decisions.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const UV_VERSION = '0.12.10';

function dataDir(env = process.env, platform = process.platform) {
  if (env.DBG_HOME) return path.resolve(env.DBG_HOME);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Dbg');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Dbg');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'dbg');
}

function findPython(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const run = options.run || spawnSync;
  const candidates = [];
  if (env.DBG_PYTHON) candidates.push([env.DBG_PYTHON]);
  candidates.push(['python3'], ['python']);
  if (platform === 'win32') candidates.push(['py', '-3']);
  for (const candidate of candidates) {
    const result = run(candidate[0], [...candidate.slice(1), '-c', 'import sys; print(str(sys.version_info.major)+"."+str(sys.version_info.minor))'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, env,
    });
    if (result.error || result.status !== 0) continue;
    const match = String(result.stdout || '').trim().match(/^(\d+)\.(\d+)$/);
    if (match && (Number(match[1]) > 3 || Number(match[1]) === 3 && Number(match[2]) >= 11)) return candidate;
  }
  return null;
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 600000, ...options });
  if (result.error || result.status !== 0) throw new Error(`Runtime preparation failed: ${path.basename(command)} (${result.error ? result.error.code : result.status})`);
  return String(result.stdout || '').trim();
}

function ensurePython() {
  const existing = findPython();
  if (existing) return existing;
  let uv = 'uv';
  const probe = spawnSync(uv, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (probe.error || probe.status !== 0) {
    const installDir = path.join(dataDir(), 'bootstrap', 'uv');
    fs.mkdirSync(installDir, { recursive: true });
    uv = path.join(installDir, process.platform === 'win32' ? 'uv.exe' : 'uv');
    if (!fs.existsSync(uv)) {
      const filename = process.platform === 'win32' ? 'install.ps1' : 'install.sh';
      const installer = path.join(installDir, filename);
      checked('curl', ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '20', '--max-time', '180',
        '--output', installer, `https://astral.sh/uv/${UV_VERSION}/${filename}`]);
      const env = { ...process.env, UV_UNMANAGED_INSTALL: installDir, UV_NO_MODIFY_PATH: '1' };
      if (process.platform === 'win32') checked(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer], { env });
      else checked('/bin/sh', [installer], { env });
      if (!fs.existsSync(uv)) throw new Error('uv installation did not produce the expected isolated runtime');
    }
  }
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(dataDir(), 'bootstrap', 'python') };
  checked(uv, ['python', 'install', '3.12'], { env });
  const python = checked(uv, ['python', 'find', '--managed-python', '3.12'], { env });
  if (!fs.existsSync(python)) throw new Error('Python prepared by uv was not found');
  return [python];
}

function doctor(python, args) {
  return spawnSync(python[0], [...python.slice(1), path.join(__dirname, 'doctor.py'), 'doctor', ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 1200000,
    env: { ...process.env, DBG_NODE: process.execPath, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
}

function runMcp(backend, options = {}) {
  const allowed = ['x64dbg', 'x32dbg', 'ghidra', 'windbg', 'ida-mcp'];
  if (!allowed.includes(backend)) throw new Error('Unknown MCP backend');
  // Resolve relative configuration before leaving the plugin cache directory that the host may rename.
  if (process.env.DBG_HOME) process.env.DBG_HOME = path.resolve(process.env.DBG_HOME);
  if (process.env.DBG_PYTHON && /[\\/]/.test(process.env.DBG_PYTHON)) {
    process.env.DBG_PYTHON = path.resolve(process.env.DBG_PYTHON);
  }
  const home = path.resolve(options.dataDir || dataDir());
  fs.mkdirSync(home, { recursive: true });
  process.chdir(home);
  const python = (options.ensurePython || ensurePython)();
  // MCP may start before the SessionStart hook; both coordinate through the same doctor lock.
  const setup = (options.doctor || doctor)(python, ['--auto']);
  if (setup.error) process.stderr.write('Dbg automatic deployment is incomplete; reporting current backend status.\n');
  const launch = options.spawn || spawn;
  const child = launch(python[0], [...python.slice(1), path.join(__dirname, 'managed_server.py'), backend], {
    cwd: home, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  child.on('error', () => { process.stderr.write('Dbg could not start the MCP backend.\n'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = Number.isInteger(code) ? code : 1; });
}

function main(argv = process.argv.slice(2)) {
  const mode = argv[0] || 'doctor';
  if (!['doctor', 'mcp', 'hook'].includes(mode)) throw new Error('Usage: dbg doctor [--tool tool] [--json]');
  if (mode === 'mcp') return runMcp(argv[1]);
  const python = ensurePython();
  if (mode === 'doctor' || mode === 'hook') {
    const result = doctor(python, mode === 'hook' ? ['--auto', '--json'] : argv.slice(1));
    if (mode === 'hook') {
      if (result.error || result.status !== 0) {
        process.stdout.write(JSON.stringify({ systemMessage: 'Dbg first deployment has incomplete items. Run dbg doctor to retry; see last-report.json in the Dbg data directory.' }));
      }
      return;
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) process.stderr.write(`Dbg execution failed: ${result.error.code}\n`);
    process.exitCode = Number.isInteger(result.status) ? result.status : 1;
    return;
  }
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { dataDir, findPython, ensurePython, runMcp, main };
