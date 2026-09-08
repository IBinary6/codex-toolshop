#!/usr/bin/env node
'use strict';

// 插件、终端与 MCP 共用此入口；安装决策全部由脚本执行。
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
  if (result.error || result.status !== 0) throw new Error(`运行时准备失败：${path.basename(command)}（${result.error ? result.error.code : result.status}）`);
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
      if (!fs.existsSync(uv)) throw new Error('uv 安装未产生预期的独立运行时');
    }
  }
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(dataDir(), 'bootstrap', 'python') };
  checked(uv, ['python', 'install', '3.12'], { env });
  const python = checked(uv, ['python', 'find', '--managed-python', '3.12'], { env });
  if (!fs.existsSync(python)) throw new Error('未找到 uv 准备的 Python');
  return [python];
}

function doctor(python, args) {
  return spawnSync(python[0], [...python.slice(1), path.join(__dirname, 'doctor.py'), 'doctor', ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 1200000,
    env: { ...process.env, DBG_NODE: process.execPath, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
}

function main(argv = process.argv.slice(2)) {
  const mode = argv[0] || 'doctor';
  if (!['doctor', 'mcp', 'hook'].includes(mode)) throw new Error('用法：dbg doctor [--tool 工具] [--json]');
  const python = ensurePython();
  if (mode === 'doctor' || mode === 'hook') {
    const result = doctor(python, mode === 'hook' ? ['--auto', '--json'] : argv.slice(1));
    if (mode === 'hook') {
      if (result.error || result.status !== 0) {
        process.stdout.write(JSON.stringify({ systemMessage: 'Dbg 首次部署有未完成项。执行 dbg doctor 可重试；详情见 Dbg 数据目录中的 last-report.json。' }));
      }
      return;
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) process.stderr.write(`Dbg 执行失败：${result.error.code}\n`);
    process.exitCode = Number.isInteger(result.status) ? result.status : 1;
    return;
  }
  const allowed = ['x64dbg', 'x32dbg', 'ghidra', 'windbg', 'ida-mcp'];
  if (!allowed.includes(argv[1])) throw new Error('未知 MCP 后端');
  // MCP 可能先于 SessionStart hook 启动，两者通过 doctor 的同一把锁协调。
  const setup = doctor(python, ['--auto']);
  if (setup.error) process.stderr.write('Dbg 自动部署未完成，将报告后端当前状态。\n');
  const child = spawn(python[0], [...python.slice(1), path.join(__dirname, 'managed_server.py'), argv[1]], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  child.on('error', () => { process.stderr.write('Dbg 无法启动 MCP 后端。\n'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = Number.isInteger(code) ? code : 1; });
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { dataDir, findPython, ensurePython, main };
