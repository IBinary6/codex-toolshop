#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgrep-smoke-'));
const repo = path.join(temp, 'repo');
process.env.TGREP_SEARCH_HOME = path.join(temp, 'private');
process.env.TGREP_IDLE_MS = '5000';
process.env.TGREP_DISABLE_UPDATES = '1';
const api = require('./tgrep.cjs');
const contexts = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function waitStopped(ctx, childPid, timeout = 10000) {
  // stop 只确认请求已接收；RPC 关闭早于 child 回收与锁清理，不能用不可达作为完成信号。
  const manager = path.join(ctx.dir, 'manager.json');
  const serviceLock = path.join(ctx.dir, 'service.lock');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((!childPid || !processExists(childPid)) && !fs.existsSync(manager) && !fs.existsSync(serviceLock)) break;
    await wait(50);
  }
  if (childPid) assert.equal(processExists(childPid), false, 'owned tgrep child must exit before deadline');
  assert.equal(fs.existsSync(manager), false, 'manager state must be removed before restart');
  assert.equal(fs.existsSync(serviceLock), false, 'service lock must be released before restart');
}
async function stopAndWait(ctx) {
  // 查询可能刚启动后台任务；先等待它发布管理入口，避免 stop 早于 start。
  let state;
  for (let i = 0; i < 50; i++) { state = await api.managed(ctx); if (state) break; await wait(100); }
  let childPid;
  if (state?.status) childPid = JSON.parse(fs.readFileSync(path.join(ctx.index, 'serve.json'), 'utf8')).pid;
  if (state) await api.managed(ctx, 'stop');
  await waitStopped(ctx, childPid);
}
async function cli(args, cwd = repo) {
  const result = await api.run(process.execPath, [path.join(__dirname, 'tgrep.cjs'), ...args], cwd);
  return { ...result, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
(async () => {
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  // 只在 mkdtemp 自有目录建立最小 Git 仓库，不操作用户仓库。
  const init = spawnSync('git', ['init', '-q', repo], { windowsHide: true, shell: false });
  assert.equal(init.status, 0);
  fs.writeFileSync(path.join(repo, 'root.txt'), 'root-only-marker\n');
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'initial-needle\n');
  const hookStarted = Date.now();
  const hook = spawnSync(process.execPath, [path.join(__dirname, 'run-hook.cjs'), 'session_start'], { cwd: repo, input: JSON.stringify({ cwd: repo, session_id: 'isolated-smoke' }), env: process.env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000 });
  assert.equal(hook.status, 0, hook.stderr);
  assert.ok(Date.now() - hookStarted < 5000, 'SessionStart must not wait for download/index');
  assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /tgrep\.cjs/);
  const ctx = api.context(repo);
  contexts.push(ctx);
  try {
    // 同一 root 并发启动只产生一个拥有者。
    api.start(ctx); api.start(ctx);
    let status;
    for (let i = 0; i < 600; i++) { status = await api.managed(ctx, 'touch'); if (status?.phase === 'ready') break; await wait(200); }
    assert.equal(status?.phase, 'ready', JSON.stringify(status));
    const binary = api.executable();
    assert.equal(spawnSync(binary, ['--version'], { windowsHide: true }).status, 0);
    console.log(`SessionStart cold install; startup phase: ${status.phase}`);
    let result = await cli(['search', '-F', '-n', '--', 'initial-needle', '.']);
    assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /initial-needle/); assert.doesNotMatch(result.stderr, /scanning disk|verifying by disk/);
    if (process.platform === 'win32') {
      // 从系统查询真实 8.3 名称；junction 回归不能替代这条路径。
      const shortResult = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/c', 'for %I in ("%TGREP_TEST_PATH%") do @echo %~sI'], { env: { ...process.env, TGREP_TEST_PATH: repo }, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, shell: false });
      assert.equal(shortResult.status, 0, shortResult.stderr);
      const short = shortResult.stdout.trim();
      assert.match(short, /~/, 'Windows smoke requires a real 8.3 path');
      assert.equal(api.context(short).root, ctx.root);
      assert.equal(api.context(short).index, ctx.index);
      for (const [queryPath, queryCwd] of [[short, repo], ['.', short]]) {
        const shortQuery = await cli(['search', '-F', '--', 'initial-needle', queryPath], queryCwd);
        assert.equal(shortQuery.code, 0, shortQuery.stderr);
        assert.doesNotMatch(shortQuery.stderr, /scanning disk|verifying by disk/);
      }
      const shortNarrow = await cli(['search', '-F', '--', 'root-only-marker', path.join(short, 'src')]);
      assert.equal(shortNarrow.code, 1, shortNarrow.stdout + shortNarrow.stderr);
      const shortMissing = await cli(['search', '-F', '--', 'initial-needle', path.join(short, 'missing')]);
      assert.equal(shortMissing.code, 2, shortMissing.stdout + shortMissing.stderr);
      console.log('PASS: real Windows 8.3 explicit path and cwd use ready index; missing path remains error 2');
      const alias = path.join(temp, 'repo-junction');
      fs.symlinkSync(repo, alias, 'junction');
      const aliasContext = api.context(alias);
      assert.equal(aliasContext.root, ctx.root);
      assert.equal(aliasContext.index, ctx.index);
      const aliasResult = await cli(['search', '-F', '--', 'initial-needle', alias]);
      assert.equal(aliasResult.code, 0, aliasResult.stderr);
      assert.doesNotMatch(aliasResult.stderr, /scanning disk|verifying by disk/);
      const aliasCwd = await cli(['search', '-F', '--', 'initial-needle', '.'], alias);
      assert.equal(aliasCwd.code, 0, aliasCwd.stderr);
      assert.doesNotMatch(aliasCwd.stderr, /scanning disk|verifying by disk/);
      const narrow = await cli(['search', '-F', '--', 'root-only-marker', path.join(alias, 'src')]);
      assert.equal(narrow.code, 1, narrow.stdout + narrow.stderr);
      const missing = await cli(['search', '-F', '--', 'initial-needle', path.join(alias, 'missing')]);
      assert.equal(missing.code, 2, missing.stdout + missing.stderr);
      const outside = path.join(temp, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside-only-marker');
      const outsideAlias = path.join(repo, 'outside-junction');
      fs.symlinkSync(outside, outsideAlias, 'junction');
      const external = await cli(['search', '-F', '--', 'outside-only-marker', outsideAlias]);
      assert.equal(external.code, 0, external.stderr);
      assert.match(external.stderr, /scanning disk/);
      fs.unlinkSync(outsideAlias);
      fs.unlinkSync(alias);
    }
    // 在隔离 data 中模拟已验证的新 active 指针；存活服务仍应使用启动时版本。
    const updates = require('./release-update.cjs');
    const next = JSON.parse(JSON.stringify(updates.fallback));
    next.version = '2.0.0';
    for (const asset of Object.values(next.assets)) { asset.url = asset.url.replaceAll('v1.0.5', 'v2.0.0'); asset.archive = asset.archive.replace('v1.0.5', 'v2.0.0'); }
    const activeFile = path.join(api.home(), 'active-release.json');
    api.atomicJSON(activeFile, next);
    try {
      const held = await cli(['search', '-F', '--', 'initial-needle', '.']);
      assert.equal(held.code, 0, held.stderr);
      assert.doesNotMatch(held.stderr, /scanning disk|verifying by disk/);
      const diagnostic = await cli(['doctor']);
      assert.equal(diagnostic.code, 0, diagnostic.stderr);
      const details = JSON.parse(diagnostic.stdout);
      assert.equal(details.activeVersion, '2.0.0');
      assert.equal(details.serviceVersion, '1.0.5');
      assert.equal(details.index, ctx.index);
    } finally { fs.unlinkSync(activeFile); }
    result = await cli(['search', '-F', '--', 'root-only-marker', '.'], path.join(repo, 'src'));
    assert.equal(result.code, 1, result.stdout + result.stderr);
    fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'updated-needle\n');
    result = await cli(['search', '--fresh', '-F', '--', 'updated-needle', '.']);
    assert.equal(result.code, 0, result.stderr);
    result = await cli(['search', '--fresh', '-F', '--', 'initial-needle', '.']);
    assert.equal(result.code, 1);
    fs.writeFileSync(path.join(repo, 'src', 'new.txt'), 'brand-new-marker\n');
    result = await cli(['search', '-F', '--', 'brand-new-marker', '.']);
    assert.equal(result.code, 0, result.stderr);
    const resultHelp = await cli(['search', '--fresh', '-F', '--', '--help', '.']);
    assert.equal(resultHelp.code, 1); assert.doesNotMatch(resultHelp.stdout, /Exit:/);
    const state = await api.managed(ctx);
    assert.equal(state.pid, status.pid, 'duplicate supervisor');
    const discovery = JSON.parse(fs.readFileSync(path.join(ctx.index, 'serve.json'), 'utf8'));
    await api.managed(ctx, 'stop');
    await waitStopped(ctx, discovery.pid);
    assert.equal(await api.managed(ctx), null);
    api.start(ctx);
    for (let i = 0; i < 50 && !await api.managed(ctx); i++) await wait(100);
    let idleChild;
    for (let i = 0; i < 50; i++) { const next = await api.managed(ctx); if (next?.phase === 'ready') { idleChild = JSON.parse(fs.readFileSync(path.join(ctx.index, 'serve.json'), 'utf8')).pid; break; } await wait(100); }
    assert.ok(idleChild);
    await wait(11000);
    await waitStopped(ctx, idleChild);
    assert.equal(await api.managed(ctx), null, 'idle supervisor should stop');
    const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { windowsHide: true, shell: false, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    git(['add', '.']);
    git(['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'isolated fixture']);
    const linked = path.join(temp, 'linked');
    git(['worktree', 'add', '--detach', linked]);
    const linkedCtx = api.context(linked);
    contexts.push(linkedCtx);
    assert.notEqual(linkedCtx.dir, ctx.dir);
    assert.equal(linkedCtx.root, process.platform === 'win32' ? fs.realpathSync.native(linked) : fs.realpathSync(linked));
    fs.writeFileSync(path.join(linked, 'only-linked.txt'), 'linked-unique-marker');
    const linkedResult = await cli(['search', '--fresh', '-F', '--', 'linked-unique-marker', '.'], linked);
    assert.equal(linkedResult.code, 0, linkedResult.stderr);
    for (let i = 0; i < 40 && !await api.managed(linkedCtx); i++) await wait(100);
    await stopAndWait(linkedCtx);
    const originalResult = await cli(['search', '--fresh', '-F', '--', 'linked-unique-marker', '.']);
    assert.equal(originalResult.code, 1);
    const conflict = { pid: process.pid, port: 1 };
    await stopAndWait(ctx);
    fs.mkdirSync(ctx.index, { recursive: true });
    fs.writeFileSync(path.join(ctx.index, 'serve.json'), JSON.stringify(conflict));
    api.start(ctx);
    let conflictState;
    for (let i = 0; i < 50; i++) { conflictState = await api.managed(ctx); if (conflictState?.phase === 'error') break; await wait(100); }
    assert.equal(conflictState?.phase, 'error');
    assert.match(conflictState.error, /orphan\/conflict/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.index, 'serve.json'), 'utf8')), conflict);
    console.log('PASS: pinned install, SHA256, serve, dedup, subdirectory scope, disk freshness, new-file search, stop and idle reap');
  } finally { await stopAndWait(ctx); }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  // 包括查询末尾刚 fork、尚未发布 manager 的进程，等待其空闲退出再清理。
  await wait(11000);
  for (const ctx of contexts) await waitStopped(ctx);
  // 只清理明确解析到系统临时目录内的本次生成目录。
  const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(temp));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});
