'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { parse, searchArgs, lock, rpc, context, run, selectedRelease, executable } = require('../scripts/tgrep.cjs');
const { runHook } = require('../scripts/run-hook.cjs');
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
test('implicit non-Git search scans parsed paths without creating service or index state', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tgrep-non-git-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tgrep-non-git-outside-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgrep-non-git-data-'));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(cwd, 'first'));
  fs.mkdirSync(path.join(cwd, 'second'));
  fs.writeFileSync(path.join(cwd, 'first', 'one.txt'), 'implicit-scan-marker\n');
  fs.writeFileSync(path.join(cwd, 'second', 'two.txt'), 'implicit-scan-marker\n');
  const outsideFile = path.join(outside, 'outside.txt');
  fs.writeFileSync(outsideFile, 'external-absolute-marker\n');
  const cli = path.resolve(__dirname, '../scripts/tgrep.cjs');
  const searchEnv = { ...process.env, TGREP_SEARCH_HOME: data };
  delete searchEnv.TGREP_DISABLE_UPDATES;
  const managementEnv = { ...searchEnv, TGREP_DISABLE_UPDATES: '1' };
  const result = spawnSync(process.execPath, [cli, 'search', '-F', '-n', '--', 'implicit-scan-marker', 'first', 'second'], { cwd, env: searchEnv, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /one\.txt/);
  assert.match(result.stdout, /two\.txt/);
  assert.equal(fs.existsSync(path.join(data, 'worktrees')), false, 'implicit scan must not create service/index state');
  const defaultPath = spawnSync(process.execPath, [cli, 'search', '-F', '--', 'implicit-scan-marker'], { cwd, env: searchEnv, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(defaultPath.status, 0, defaultPath.stderr);
  const externalDir = spawnSync(process.execPath, [cli, 'search', '-F', '--', 'external-absolute-marker', outside], { cwd, env: searchEnv, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(externalDir.status, 0, externalDir.stderr);
  assert.match(externalDir.stdout, /outside\.txt/);
  const externalFile = spawnSync(process.execPath, [cli, 'search', '-F', '--', 'external-absolute-marker', outsideFile], { cwd, env: searchEnv, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(externalFile.status, 0, externalFile.stderr);
  const distinctTargets = spawnSync(process.execPath, [cli, 'search', '-F', '--', 'marker', 'first', outside], { cwd, env: searchEnv, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(distinctTargets.status, 0, distinctTargets.stderr);
  assert.match(distinctTargets.stdout, /one\.txt/);
  assert.match(distinctTargets.stdout, /outside\.txt/);
  const files = spawnSync(process.execPath, [cli, 'search', '--files', '--', outside], { cwd, env: searchEnv, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(files.status, 0, files.stderr);
  assert.match(files.stdout, /outside\.txt/);
  const noMatch = spawnSync(process.execPath, [cli, 'search', '-F', '--', 'absent-scan-marker', '.'], { cwd, env: searchEnv, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(noMatch.status, 1, noMatch.stderr);
  const missing = spawnSync(process.execPath, [cli, 'search', '-F', '--', 'implicit-scan-marker', 'missing'], { cwd, env: searchEnv, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(missing.status, 2);
  assert.equal(fs.existsSync(path.join(data, 'update-request.json')), false, 'implicit scan must not schedule updates');
  assert.equal(fs.existsSync(path.join(data, 'worktrees')), false, 'implicit scan must not create service/index state');
  const explicitRoot = spawnSync(process.execPath, [cli, 'search', '--root', outside, '-F', '--', 'implicit-scan-marker', 'first'], { cwd, env: managementEnv, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(explicitRoot.status, 0, explicitRoot.stderr);
  assert.match(explicitRoot.stdout, /one\.txt/);
  for (const command of ['ensure', 'status', 'doctor', 'stop']) {
    const management = spawnSync(process.execPath, [cli, command], { cwd, env: managementEnv, encoding: 'utf8', windowsHide: true, shell: false });
    assert.equal(management.status, 2, `${command}: ${management.stderr}`);
    assert.match(management.stderr, /outside a Git worktree/);
  }
});
test('implicit non-Git search uses an existing tgrep runtime in scan-only mode', t => {
  const release = selectedRelease();
  const sourceBinary = executable(release);
  if (!fs.existsSync(sourceBinary)) return t.skip('no installed tgrep runtime available');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tgrep-non-git-runtime-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgrep-non-git-runtime-data-'));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(cwd, 'source.txt'), 'existing-runtime-marker\n');
  fs.writeFileSync(path.join(data, 'active-release.json'), JSON.stringify(release));
  const destinationDir = path.join(data, 'runtime', release.version, `${process.platform}-${process.arch}`);
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(sourceBinary, path.join(destinationDir, path.basename(sourceBinary)));
  fs.copyFileSync(path.join(path.dirname(sourceBinary), 'receipt.json'), path.join(destinationDir, 'receipt.json'));
  fs.writeFileSync(path.join(destinationDir, 'release.json'), JSON.stringify(release));
  const cli = path.resolve(__dirname, '../scripts/tgrep.cjs');
  const result = spawnSync(process.execPath, [cli, 'search', '-F', '-n', '--', 'existing-runtime-marker', '.'], {
    cwd,
    env: { ...process.env, TGREP_SEARCH_HOME: data, TGREP_DISABLE_UPDATES: '1' },
    encoding: 'utf8',
    windowsHide: true,
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /source\.txt/);
  assert.doesNotMatch(result.stderr, /falling back to rg/);
  assert.match(result.stderr, /scanning disk/);
  assert.equal(fs.existsSync(path.join(data, 'worktrees')), false, 'scan-only mode must not create an index or manager state');
});
test('hook entry events share CLI guidance while SubagentStart returns before side effects', async () => {
  const calls = [];
  const api = {
    maybeCheckUpdates() { calls.push('update'); },
    context() { calls.push('context'); return { git: true }; },
    async managed() { calls.push('managed'); return null; },
    start() { calls.push('start'); }
  };
  const subagentOutput = [];
  await runHook('subagent_start', { cwd: root }, api, value => subagentOutput.push(JSON.parse(value)));
  assert.deepEqual(calls, []);
  assert.equal(subagentOutput[0].hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.match(subagentOutput[0].hookSpecificOutput.additionalContext, /不是 MCP/);
  assert.match(subagentOutput[0].hookSpecificOutput.additionalContext, /workdir/);
  assert.match(subagentOutput[0].hookSpecificOutput.additionalContext, /--root/);
  assert.match(subagentOutput[0].hookSpecificOutput.additionalContext, /PATH/);

  const nonGitOutput = [];
  api.context = () => { calls.push('context'); return null; };
  await runHook('session_start', { cwd: root }, api, value => nonGitOutput.push(JSON.parse(value)));
  assert.deepEqual(calls, ['context']);
  assert.equal(nonGitOutput[0].hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(nonGitOutput[0].hookSpecificOutput.additionalContext, /不是 MCP/);

  calls.length = 0;
  api.context = () => { calls.push('context'); return { git: true }; };
  api.managed = async () => { calls.push('managed'); return { phase: 'ready' }; };
  const promptOutput = [];
  await runHook('user_prompt_submit', { cwd: root }, api, value => promptOutput.push(value));
  assert.deepEqual(calls, ['context', 'update', 'managed']);
  assert.deepEqual(promptOutput, []);
});
test('hook manifests register SubagentStart with the dedicated event argument', () => {
  for (const name of ['hooks.json', 'codex-hooks.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../hooks', name), 'utf8'));
    assert.equal(manifest.hooks.SubagentStart.length, 1);
    assert.match(manifest.hooks.SubagentStart[0].hooks[0].command, /run-hook\.cjs\" subagent_start$/);
  }
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
test('Windows directory aliases map to the same physical query scope', { skip: process.platform !== 'win32' }, () => {
  const real = path.join(root, 'alias-target');
  const alias = path.join(root, 'alias-junction');
  fs.mkdirSync(path.join(real, 'src'), { recursive: true });
  fs.symlinkSync(real, alias, 'junction');
  const canonicalSource = fs.realpathSync.native(path.join(real, 'src'));
  const explicit = parse(['search', '-F', '--', 'needle', path.join(alias, 'src')], root);
  const implicit = parse(['search', '-F', '--', 'needle', '.'], path.join(alias, 'src'));
  assert.deepEqual(explicit.paths, [canonicalSource]);
  assert.deepEqual(implicit.paths, [canonicalSource]);
  const missing = path.join(alias, 'does-not-exist');
  assert.deepEqual(parse(['search', '--', 'needle', missing], root).paths, [missing]);
});
test('Windows real 8.3 paths expand for explicit and implicit query scopes', { skip: process.platform !== 'win32' }, () => {
  const { spawnSync } = require('node:child_process');
  const long = path.join(root, 'long-directory-for-short-path-regression');
  fs.mkdirSync(long);
  // cmd 的 %~sI 查询实际 Windows 短文件名，不拼造 ~1 路径。
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/c', 'for %I in ("%TGREP_TEST_PATH%") do @echo %~sI'], { env: { ...process.env, TGREP_TEST_PATH: long }, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, shell: false });
  assert.equal(result.status, 0, result.stderr);
  const short = result.stdout.trim();
  assert.match(short, /~/, 'this regression requires an actual 8.3 alias');
  const physical = fs.realpathSync.native(long);
  assert.equal(fs.realpathSync.native(short), physical);
  assert.deepEqual(parse(['search', '--', 'needle', short], root).paths, [physical]);
  assert.deepEqual(parse(['search', '--', 'needle', '.'], short).paths, [physical]);
  const missing = path.join(short, 'missing');
  assert.deepEqual(parse(['search', '--', 'needle', missing], root).paths, [missing]);
});
