'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { prepareToolCall } = require('../../../scripts/mcp-read-barrier.cjs');

async function main() {
  const never = { spawn() { throw new Error('unexpected preparation'); } };
  const registry = { name: 'list_repos_tool' };
  assert.equal(await prepareToolCall(registry, never), registry);
  await assert.rejects(prepareToolCall({ name: 'query_graph_tool' }, never), /absolute repo_root/);
  await assert.rejects(prepareToolCall({ name: 'query_graph_tool', arguments: { repo_root: '.' } }, never), /absolute repo_root/);
  const root = path.resolve('test-repository');
  const params = { name: 'query_graph_tool', arguments: { repo_root: root, target: 'symbol' } };
  const fixture = (result, code) => ({ spawn(command, args) {
    assert.equal(JSON.parse(args[1]).root, root);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => { child.stdout.write(JSON.stringify(result)); child.emit('close', code); });
    return child;
  } });
  const result = await prepareToolCall(params, fixture({ ok: true, root }, 0));
  assert.deepEqual(result, params);
  await assert.rejects(prepareToolCall(params, fixture({ ok: false, diagnostic: 'refresh failed' }, 1)), /refresh failed/);
  const controller = new AbortController();
  let killed = 0;
  const pending = prepareToolCall(params, {
    signal: controller.signal,
    spawn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      return child;
    },
    async killTree() { killed += 1; },
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(killed, 1);
  await assert.rejects(prepareToolCall(params, { ...never, signal: controller.signal }), /cancelled/);
  console.log('mcp_read_barrier PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
