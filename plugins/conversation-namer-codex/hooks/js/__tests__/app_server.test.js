'use strict';

const assert = require('assert').strict;
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { createAppServer } = require('../lib/app_server');

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
  let invocation;
  const child = fakeProcess((message, process) => {
    if (message.id) process.reply({ id: message.id, result: { received: message.method } });
  });
  const rpc = createAppServer({ cwd: '/temporary', timeoutMs: 2000, spawnImpl(command, args, options) {
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
  const rejectRpc = createAppServer({ timeoutMs: 1000, spawnImpl: () => rejected });
  await assert.rejects(rejectRpc.request('turn/start'), /app_server_request_rejected/);
  assert.equal(rejected.messages.find((message) => message.id === 'approval').error.code, -32601);
  await rejectRpc.close();

  const errorChild = fakeProcess((message, process) => process.reply({ id: message.id, error: { code: 123, message: 'private-provider-details' } }));
  const errorRpc = createAppServer({ timeoutMs: 1000, spawnImpl: () => errorChild });
  await assert.rejects(errorRpc.request('broken'), (error) => error.message === 'app_server_rpc_failed');
  await errorRpc.close();

  const hung = fakeProcess(null, { stubborn: true });
  const timeoutRpc = createAppServer({ timeoutMs: 20, spawnImpl: () => hung });
  await assert.rejects(timeoutRpc.request('never-returns'), /app_server_timeout/);
  await timeoutRpc.close();
  assert.ok(hung.kills.includes('SIGKILL'));

  const malformed = fakeProcess((message, process) => process.stdout.write('not-json\n'));
  const malformedRpc = createAppServer({ timeoutMs: 1000, spawnImpl: () => malformed });
  await assert.rejects(malformedRpc.request('read'), /app_server_invalid_json/);
  await malformedRpc.close();

  const exiting = fakeProcess((message, process) => process.emit('exit', 1));
  const exitRpc = createAppServer({ timeoutMs: 1000, spawnImpl: () => exiting });
  await assert.rejects(exitRpc.request('read'), /app_server_exited/);
  await exitRpc.close();

  const unavailable = fakeProcess();
  unavailable.pid = undefined;
  const unavailableRpc = createAppServer({ timeoutMs: 1000, spawnImpl: () => unavailable });
  queueMicrotask(() => unavailable.emit('error', new Error('ENOENT')));
  await assert.rejects(unavailableRpc.request('read'), /app_server_unavailable/);
  await unavailableRpc.close();
  assert.throws(() => createAppServer({ timeoutMs: 0 }), /invalid_timeout/);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
