'use strict';

const assert = require('assert').strict;
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough, Writable } = require('stream');
const { createAppServer, resolveCodexCommand } = require('../lib/app_server');

function executable(file, mtimeMs = Date.now()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.chmodSync(file, 0o755);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function testOtherPlatforms() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'namer-platforms-'));
  const originalCwd = process.cwd();
  try {
    // 相对 PATH 目录避免 Windows 测试宿主的盘符冒充 Unix PATH 分隔符。
    process.chdir(root);
    const cli = executable(path.join(root, 'cli', 'codex'));
    const desktop = executable(path.join(root, 'Codex.app', 'Contents', 'Resources', 'bin', 'codex'));
    const cliDir = path.relative(root, path.dirname(cli));
    const desktopDir = path.relative(root, path.dirname(desktop));
    const env = { PATH: [cliDir, desktopDir].join(':') };
    assert.equal(resolveCodexCommand({ env: { ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }, platform: 'darwin' }), path.join(desktopDir, 'codex'));
    assert.equal(resolveCodexCommand({ env: { ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_cli_rs' }, platform: 'darwin' }), path.join(cliDir, 'codex'));
    assert.equal(resolveCodexCommand({ env, platform: 'darwin' }), path.join(cliDir, 'codex'));
    assert.equal(resolveCodexCommand({ env: { PATH: cliDir, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }, platform: 'linux' }), path.join(cliDir, 'codex'));
    assert.equal(resolveCodexCommand({ env: { PATH: cliDir }, platform: 'linux' }), path.join(cliDir, 'codex'));
    assert.equal(resolveCodexCommand({ env: { PATH: 'missing' }, platform: 'linux' }), null);
    const userDesktop = executable(path.join(root, 'home', 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'));
    const systemApplicationsRoot = path.join(root, 'system-applications');
    const systemDesktop = executable(path.join(systemApplicationsRoot, 'Codex.app', 'Contents', 'Resources', 'codex'));
    const desktopEnv = { PATH: '', HOME: path.join(root, 'home'), CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' };
    assert.equal(resolveCodexCommand({ env: desktopEnv, platform: 'darwin', systemApplicationsRoot }), systemDesktop);
    fs.unlinkSync(systemDesktop);
    assert.equal(resolveCodexCommand({ env: desktopEnv, platform: 'darwin', systemApplicationsRoot }), userDesktop);
    fs.mkdirSync(path.join(root, 'directory-only', 'codex'), { recursive: true });
    assert.equal(resolveCodexCommand({ env: { PATH: 'directory-only' }, platform: 'linux' }), null);
    if (process.platform !== 'win32') {
      const nonExecutable = executable(path.join(root, 'not-executable', 'codex'));
      fs.chmodSync(nonExecutable, 0o644);
      assert.equal(resolveCodexCommand({ env: { PATH: path.relative(root, path.dirname(nonExecutable)) }, platform: 'linux' }), null);
    }
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCommandDiscovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'namer-executables-'));
  try {
    const localAppData = path.join(root, 'Local');
    const cli = executable(path.join(root, 'cli', 'codex.exe'));
    const oldDesktop = executable(path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'old', 'codex.exe'), 1000000);
    const newDesktop = executable(path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'new', 'codex.exe'), 2000000);
    const env = { PATH: [path.dirname(cli), path.dirname(oldDesktop)].join(';'), LOCALAPPDATA: localAppData };
    assert.equal(resolveCodexCommand({ env: { ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }, platform: 'win32' }), oldDesktop);
    assert.equal(resolveCodexCommand({ env: { ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'CODEX DESKTOP' }, platform: 'win32' }), oldDesktop);
    assert.equal(resolveCodexCommand({ env: { ...env, CODEX_APP_TOOLS_PIPE_PATH: 'pipe' }, platform: 'win32' }), oldDesktop);
    assert.equal(resolveCodexCommand({ env: { ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_cli_rs', CODEX_APP_TOOLS_PIPE_PATH: 'pipe' }, platform: 'win32' }), cli);
    assert.equal(resolveCodexCommand({ env: { ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_cli' }, platform: 'win32' }), cli);
    assert.equal(resolveCodexCommand({ env, platform: 'win32' }), cli);
    assert.equal(resolveCodexCommand({ env: { ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'unknown-origin' }, platform: 'win32' }), cli);
    assert.equal(resolveCodexCommand({ env: { ...env, PATH: path.dirname(oldDesktop) }, platform: 'win32' }), oldDesktop);
    assert.equal(resolveCodexCommand({ env: { ...env, PATH: '', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }, platform: 'win32' }), newDesktop);
    assert.equal(resolveCodexCommand({ env: { ...env, PATH: path.dirname(cli), CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }, platform: 'win32' }), newDesktop);
    assert.equal(resolveCodexCommand({ env: { ...env, PATH: path.dirname(oldDesktop), CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_cli_rs' }, platform: 'win32' }), null);
    assert.equal(resolveCodexCommand({ env: { PATH: path.join(root, 'missing'), LOCALAPPDATA: path.join(root, 'absent') }, platform: 'win32' }), null);
    assert.throws(() => createAppServer({ env: { PATH: '', LOCALAPPDATA: path.join(root, 'absent') }, platform: 'win32' }), /app_server_unavailable/);
    let invoked;
    const child = fakeProcess();
    const rpc = createAppServer({ command: 'explicit-codex', env: { PATH: '' }, platform: 'win32', spawnImpl(command) {
      invoked = command;
      return child;
    } });
    assert.equal(invoked, 'explicit-codex');
    const inherited = { ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop', CODEX_APP_TOOLS_PIPE_PATH: 'pipe' };
    let invocation;
    const discoveredChild = fakeProcess();
    const discoveredRpc = createAppServer({ env: inherited, platform: 'win32', spawnImpl(command, args, options) {
      invocation = { command, options };
      return discoveredChild;
    } });
    assert.equal(invocation.command, oldDesktop);
    assert.equal(invocation.options.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, 'Codex Desktop');
    assert.equal(invocation.options.env.CODEX_APP_TOOLS_PIPE_PATH, 'pipe');
    assert.equal(invocation.options.env.CONVERSATION_NAMER_WORKER, '1');
    return Promise.all([rpc.close(), discoveredRpc.close()]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fakeProcess(handler, { stubborn = false } = {}) {
  const child = new EventEmitter();
  child.pid = 42;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.messages = [];
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      const message = JSON.parse(chunk.toString());
      child.messages.push(message);
      if (handler) queueMicrotask(() => handler(message, child));
      callback();
    },
  });
  child.reply = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.kill = (signal = 'SIGTERM') => {
    child.kills.push(signal);
    if (!stubborn || signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', 0));
    return true;
  };
  return child;
}

async function main() {
  testOtherPlatforms();
  await testCommandDiscovery();
  let invocation;
  const child = fakeProcess((message, process) => {
    if (message.id) process.reply({ id: message.id, result: { received: message.method } });
  });
  const rpc = createAppServer({ cwd: '/temporary', timeoutMs: 2000, command: 'codex', spawnImpl(command, args, options) {
    invocation = { command, args, options };
    return child;
  } });
  assert.equal(invocation.command, 'codex');
  assert.equal(invocation.args[0], 'app-server');
  assert.equal(invocation.options.cwd, '/temporary');
  assert.equal(invocation.options.env.CONVERSATION_NAMER_WORKER, '1');
  assert.deepEqual(invocation.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(invocation.options.shell, undefined);
  assert.ok(invocation.args.includes('features.hooks=false'));
  assert.ok(invocation.args.includes('features.plugins=false'));
  assert.ok(invocation.args.includes('project_doc_max_bytes=0'));
  assert.ok(invocation.args.includes('service_tier="default"'));
  const results = await Promise.all([rpc.request('first'), rpc.request('second')]);
  assert.deepEqual(results, [{ received: 'first' }, { received: 'second' }]);
  let notification;
  const remove = rpc.onNotification((method, params) => { notification = { method, params }; });
  child.stdout.write('{"method":"event","params":');
  child.stdout.write('{"ready":true}}\n');
  assert.deepEqual(notification, { method: 'event', params: { ready: true } });
  remove();
  rpc.notify('initialized');
  assert.ok(child.messages.some((message) => message.method === 'initialized' && !message.id));
  await rpc.close();
  await rpc.close();
  assert.ok(child.kills.includes('SIGTERM'));
  await assert.rejects(rpc.request('after-close'), /app_server_closed/);

  const rejected = fakeProcess((message, process) => {
    if (message.method === 'turn/start') process.reply({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
  });
  const rejectRpc = createAppServer({ timeoutMs: 1000, command: 'codex', spawnImpl: () => rejected });
  await assert.rejects(rejectRpc.request('turn/start'), /app_server_request_rejected/);
  assert.equal(rejected.messages.find((message) => message.id === 'approval').error.code, -32601);
  await rejectRpc.close();

  const errorChild = fakeProcess((message, process) => process.reply({ id: message.id, error: { code: 123, message: 'private-provider-details' } }));
  const errorRpc = createAppServer({ timeoutMs: 1000, command: 'codex', spawnImpl: () => errorChild });
  await assert.rejects(errorRpc.request('broken'), (error) => error.message === 'app_server_rpc_failed');
  await errorRpc.close();

  const hung = fakeProcess(null, { stubborn: true });
  const timeoutRpc = createAppServer({ timeoutMs: 20, command: 'codex', spawnImpl: () => hung });
  await assert.rejects(timeoutRpc.request('never-returns'), /app_server_timeout/);
  await timeoutRpc.close();
  assert.ok(hung.kills.includes('SIGKILL'));

  const malformed = fakeProcess((message, process) => process.stdout.write('not-json\n'));
  const malformedRpc = createAppServer({ timeoutMs: 1000, command: 'codex', spawnImpl: () => malformed });
  await assert.rejects(malformedRpc.request('read'), /app_server_invalid_json/);
  await malformedRpc.close();

  const exiting = fakeProcess((message, process) => process.emit('exit', 1));
  const exitRpc = createAppServer({ timeoutMs: 1000, command: 'codex', spawnImpl: () => exiting });
  await assert.rejects(exitRpc.request('read'), /app_server_exited/);
  await exitRpc.close();

  const unavailable = fakeProcess();
  unavailable.pid = undefined;
  const unavailableRpc = createAppServer({ timeoutMs: 1000, command: 'codex', spawnImpl: () => unavailable });
  queueMicrotask(() => unavailable.emit('error', new Error('ENOENT')));
  await assert.rejects(unavailableRpc.request('read'), /app_server_unavailable/);
  await unavailableRpc.close();
  assert.throws(() => createAppServer({ timeoutMs: 0 }), /invalid_timeout/);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
