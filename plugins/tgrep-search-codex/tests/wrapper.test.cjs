'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { parse, searchArgs, lock, rpc, context, run } = require('../scripts/tgrep.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tgrep-unit-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('query paths retain caller cwd; wrapper flags cannot become backend flags', () => {
  const cwd = path.join(root, 'src');
  const q = parse(['search', '--root', root, '--fresh', '-F', '-n', '--', '-needle', '.'], cwd);
  assert.equal(q.root, root); assert.equal(q.fresh, true);
  assert.deepEqual(q.paths, [cwd]);
  const args = searchArgs(q, { index: path.join(root, 'index') }, true);
  assert.ok(args.includes('--no-index')); assert.ok(!args.includes('--root'));
  assert.ok(args.includes('--regexp=-needle'));
});
test('multi-pattern, filename listing, file-based patterns, and rejected flags', () => {
  assert.deepEqual(parse(['search', '-e', 'one', '-e', 'two', '--', '.'], root).pattern, []);
  assert.deepEqual(parse(['search', '--files', '--', 'src'], root).paths, [path.join(root, 'src')]);
  assert.equal(parse(['search', '-f', 'patterns', '.'], root).options[1], path.join(root, 'patterns'));
  assert.throws(() => parse(['search', '--index-path', 'wrong', 'x'], root), /unsupported/);
  assert.throws(() => parse(['search', '-Fn', 'x'], root), /unsupported/);
  assert.throws(() => parse(['search', '-e'], root), /needs a value/);
});
test('rg mapping has no tgrep-only index flags and preserves size policy', () => {
  const q = parse(['search', '--no-max-filesize', '-I', '--', 'needle'], root);
  const args = searchArgs(q, {}, true, true);
  assert.ok(!args.includes('--no-max-filesize')); assert.ok(!args.includes('--index-path'));
  assert.ok(args.includes('--no-filename')); assert.ok(!args.includes('--max-filesize'));
  assert.throws(() => searchArgs(parse(['search', '--stats', 'x'], root), {}, true, true), /cannot be mapped/);
});
test('live lock prevents duplicate owner and releases for a successor', () => {
  const dir = path.join(root, 'a.lock'); const release = lock(dir);
  assert.equal(typeof release, 'function'); assert.equal(lock(dir), null);
  release(); const next = lock(dir); assert.equal(typeof next, 'function'); next();
});
test('non-Git discovery does not silently admit arbitrary directories', () => {
  assert.equal(context(root), null); assert.equal(context(root, root).git, false);
});
test('RPC times out and rejects malformed response', async () => {
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.on('data', () => socket.end('invalid\n')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await assert.rejects(rpc(server.address().port, {}), SyntaxError);
  await new Promise(resolve => server.close(resolve));
});
test('query runner returns actual exit codes and captures launch failure', async () => {
  assert.equal((await run(process.execPath, ['-e', 'process.exit(1)'], root)).code, 1);
  const failed = await run(path.join(root, 'missing-executable'), [], root);
  assert.equal(failed.code, 2); assert.match(failed.stderr.toString(), /ENOENT/);
});
test('option-looking values remain values and never alter search policy', () => {
  const q = parse(['search', '-e', '--files', '-g', '--no-max-filesize', '--', '.'], root);
  assert.equal(q.fresh, false); assert.deepEqual(q.pattern, []);
  const args = searchArgs(q, {}, true, true);
  assert.ok(args.includes('--regexp=--files'));
  assert.ok(args.includes('--glob=--no-max-filesize'));
  assert.ok(args.includes('--max-filesize=64M'));
  const plain = parse(['search', '-F', '--', '--help', '.'], root);
  assert.deepEqual(plain.pattern, ['--help']);
});
test('corrupt private runtime is rejected rather than considered installed', async () => {
  const api = require('../scripts/tgrep.cjs');
  const saved = process.env.TGREP_SEARCH_HOME;
  process.env.TGREP_SEARCH_HOME = path.join(root, 'corrupt-runtime');
  try {
    const executable = api.executable();
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'corrupt');
    await assert.rejects(api.ensureBinary(), /integrity check failed/);
  } finally { if (saved === undefined) delete process.env.TGREP_SEARCH_HOME; else process.env.TGREP_SEARCH_HOME = saved; }
});
