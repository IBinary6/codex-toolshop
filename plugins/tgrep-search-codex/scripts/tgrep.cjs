#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const updates = require('./release-update.cjs');
const selectedRelease = () => updates.activeRelease(home());
const SELF = __filename;
const activeChildren = new Set();
const hidden = { windowsHide: true, shell: false };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const readJSON = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function home() {
  return path.resolve(process.env.TGREP_SEARCH_HOME || process.env.PLUGIN_DATA || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins', 'data', 'tgrep-search-codex-codex-toolshop'));
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// Windows native realpath 同时展开 junction 与真实 8.3 短文件名；JS realpath 不保证后者。
function canonical(dir) { return process.platform === 'win32' ? fs.realpathSync.native(dir) : fs.realpathSync(dir); }
function context(cwd, explicitRoot) {
  const start = canonical(explicitRoot || cwd);
  const git = spawnSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], { ...hidden, encoding: 'utf8', timeout: 3000 });
  const root = git.status === 0 ? canonical(git.stdout.trim()) : start;
  if (git.status !== 0 && !explicitRoot) return null;
  const key = hash(process.platform === 'win32' ? root.toLowerCase() : root);
  const dir = path.join(home(), 'worktrees', key);
  const version = selectedRelease().version;
  return { root, dir, version, index: updates.indexForVersion(dir, version), git: git.status === 0 };
}
// mkdir 是跨进程互斥点；只回收确认死亡的拥有者，不以超时猜测活进程身份。
function lock(dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      if (fs.existsSync(`${dir}.reap`)) return null;
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      return () => { const owner = readJSON(path.join(dir, 'owner.json')); if (owner?.pid === process.pid) fs.rmSync(dir, { recursive: true, force: true }); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const reap = `${dir}.reap`;
      try { fs.mkdirSync(reap); } catch { return null; }
      try {
        const owner = readJSON(path.join(dir, 'owner.json'));
        let age; try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { continue; }
        if ((owner && Number.isInteger(owner.pid) && !alive(owner.pid)) || (!owner && age > 30000)) {
          const stale = `${dir}.stale.${crypto.randomUUID()}`;
          fs.renameSync(dir, stale);
          fs.rmSync(stale, { recursive: true, force: true });
        } else return null;
      } finally { fs.rmdirSync(reap); }

    }
  }
  return null;
}
function installedHealthy(file, release = selectedRelease()) {
  if (!fs.existsSync(file)) return false;
  const receipt = readJSON(path.join(path.dirname(file), 'receipt.json'));
  if (!receipt || receipt.version !== release.version || receipt.archiveSha256 !== release.assets[updates.platformKey()].sha256 || hash(fs.readFileSync(file)) !== receipt.binarySha256) throw new Error('private tgrep runtime integrity check failed; remove the runtime version directory then run ensure');
  return true;
}
function executable(release = selectedRelease()) {
  updates.validateRelease(release);
  const asset = release.assets[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`unsupported platform: ${process.platform}-${process.arch}`);
  return path.join(home(), 'runtime', release.version, `${process.platform}-${process.arch}`, asset.executable);
}
async function ensureBinary(release = selectedRelease()) {
  const destination = executable(release);
  if (installedHealthy(destination, release)) return destination;
  const unlock = lock(path.join(home(), 'install.lock'));
  if (!unlock) throw new Error('installation pending in another process');
  let stage;
  try {
    if (installedHealthy(destination, release)) return destination;
    const asset = release.assets[`${process.platform}-${process.arch}`];
    const url = new URL(asset.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/microsoft/tgrep/releases/download/')) throw new Error('invalid release URL');
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('release SHA256 missing');
    stage = path.join(home(), 'runtime', `.stage-${crypto.randomUUID()}`);
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    const archive = path.join(stage, asset.archive);
    // curl 沿用宿主 HTTP(S)_PROXY；没有 curl 时使用 Node 内建 HTTPS。
    const download = await run('curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', '90', '--output', archive, url.href], stage);
    let bytes;
    if (download.code === 0) bytes = fs.readFileSync(archive);
    else if (download.stderr.toString().includes('ENOENT')) {
      const response = await updates.fetchHttps(url, { timeout: 90000 });
      if (!response.ok) throw new Error(`download HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(archive, bytes);
    } else throw new Error(`release download failed: ${download.stderr || download.error?.message}`);
    if (hash(bytes) !== asset.sha256) throw new Error('release SHA256 mismatch');
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || path.join('C:' + path.sep, 'Windows'), 'System32', 'tar.exe') : 'tar';
    const listing = spawnSync(tar, ['-tf', archive], { ...hidden, encoding: 'utf8', timeout: 15000 });
    if (listing.status !== 0) throw new Error(`tar unavailable or archive invalid: ${listing.stderr || listing.error?.message}`);
    const entries = listing.stdout.trim().split(/\r?\n/);
    if (entries.some(x => path.isAbsolute(x) || x.split(/[\/]/).includes('..'))) throw new Error('unsafe archive path');
    const entry = entries.find(x => x.replace(/^\.\//, '') === asset.executable);
    if (!entry) throw new Error('release executable missing from archive');
    const extracted = spawnSync(tar, ['-xf', archive, '-C', stage, entry], { ...hidden, timeout: 15000 });
    if (extracted.status !== 0) throw new Error('archive extraction failed');
    const binary = path.join(stage, asset.executable);
    if (!fs.lstatSync(binary).isFile() || fs.lstatSync(binary).isSymbolicLink()) throw new Error('invalid executable entry');
    fs.chmodSync(binary, 0o700);
    const version = spawnSync(binary, ['--version'], { ...hidden, encoding: 'utf8', timeout: 10000 });
    if (version.status !== 0 || version.stdout.trim() !== `tgrep ${release.version}`) throw new Error('executable version check failed');
    atomicJSON(path.join(stage, 'receipt.json'), { version: release.version, archiveSha256: asset.sha256, binarySha256: hash(fs.readFileSync(binary)) });
    atomicJSON(path.join(stage, 'release.json'), release);
    fs.unlinkSync(archive);
    fs.mkdirSync(path.dirname(path.dirname(destination)), { recursive: true, mode: 0o700 });
    fs.renameSync(stage, path.dirname(destination));
    stage = null;
    return destination;
  } finally { if (stage) fs.rmSync(stage, { recursive: true, force: true }); unlock(); }
}
function rpc(port, request, timeout = 1500) {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const fail = e => { socket.destroy(); reject(e); };
    socket.setTimeout(timeout, () => fail(new Error('RPC timeout')));
    socket.on('error', fail);
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) return fail(new Error('RPC response too large'));
      if (data.includes('\n')) { socket.destroy(); try { resolve(JSON.parse(data.split('\n')[0])); } catch (e) { reject(e); } }
    });
    socket.on('end', () => { if (!data.includes('\n')) fail(new Error('RPC closed')); });
  });
}
async function managed(ctx, action = 'status') {
  const state = readJSON(path.join(ctx.dir, 'manager.json'));
  if (!state || state.root !== ctx.root || !alive(state.pid)) return null;
  try {
    const answer = await rpc(state.port, { token: state.token, action });
    return answer.root === ctx.root && answer.id === state.id && answer.pid === state.pid ? answer : null;
  } catch { return null; }
}
function start(ctx) {
  fs.mkdirSync(ctx.dir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [SELF, '_supervise', ctx.root], { ...hidden, detached: true, stdio: 'ignore', env: process.env });
  child.on('error', () => {});
  child.unref();
}
async function supervise(root) {
  const ctx = context(root, root);
  if (!ctx?.git || ctx.root !== canonical(root)) return;
  const unlock = lock(path.join(ctx.dir, 'service.lock'));
  if (!unlock) return;
  const serviceRelease = updates.releaseForVersion(home(), ctx.version);
  let resumedIndex = true;
  let child, phase = 'installing', failure = null, lastTouch = Date.now(), closing = false;
  const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString('hex');
  const idleMs = Math.max(5000, Number(process.env.TGREP_IDLE_MS) || 30 * 60 * 1000);
  const server = net.createServer(socket => {
    socket.setTimeout(2000, () => socket.destroy());
    let input = '';
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      input += chunk;
      if (input.length > 4096) return socket.destroy();
      if (!input.includes('\n')) return;
      socket.pause();
      let request; try { request = JSON.parse(input.split('\n')[0]); } catch { return socket.destroy(); }
      if (request.token !== token) return socket.destroy();
      if (request.action === 'touch') lastTouch = Date.now();
      let status = null;
      const info = readJSON(path.join(ctx.index, 'serve.json'));
      // 只接受当前拥有的 ChildProcess 的 discovery，避免 PID 重用或陌生服务。
      if (child && child.exitCode === null && info?.pid === child.pid) {
        try { status = (await rpc(info.port, { jsonrpc: '2.0', method: 'status', id: 1 })).result; } catch {}
      }
      const ready = status && (!resumedIndex || status.last_reconcile_at) && status.indexing === false && status.reconcile_running === false && status.reconcile_pending === false && status.reconcile_overdue === false && !status.last_reconcile_error && (status.watch_mode_active === 'native' || (status.watch_mode_active === 'poll' && status.last_reconcile_at));
      socket.end(`${JSON.stringify({ root: ctx.root, version: ctx.version, index: ctx.index, pid: process.pid, id, phase: failure ? 'error' : ready ? 'ready' : phase === 'running' ? 'pending' : phase, error: failure, status })}\n`);
      if (request.action === 'stop') shutdown();
    });
  });
  async function shutdown() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    for (const transient of activeChildren) { if (transient.exitCode === null) transient.kill(); }
    server.close();
    // kill 仅通过本 supervisor 创建且未退出的 child handle；从不按磁盘 PID 杀进程。
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    const state = readJSON(path.join(ctx.dir, 'manager.json'));
    if (state?.id === id) fs.unlinkSync(path.join(ctx.dir, 'manager.json'));
    unlock();
    process.exit(0);
  }
  const timer = setInterval(() => { if (Date.now() - lastTouch > idleMs) shutdown(); }, Math.min(5000, idleMs));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    atomicJSON(path.join(ctx.dir, 'manager.json'), { root: ctx.root, version: ctx.version, index: ctx.index, pid: process.pid, id, token, port: server.address().port });
    const binary = await ensureBinary(serviceRelease);
    if (closing) return;
    resumedIndex = fs.existsSync(path.join(ctx.index, 'meta.json'));
    fs.mkdirSync(ctx.index, { recursive: true, mode: 0o700 });
    const oldInfo = path.join(ctx.index, 'serve.json');
    if (fs.existsSync(oldInfo)) {
      const previous = readJSON(oldInfo);
      if (!previous || !Number.isInteger(previous.pid) || alive(previous.pid)) throw new Error('orphan/conflict: existing serve.json may belong to a live server; refusing another index writer; inspect its process identity manually');
      fs.unlinkSync(oldInfo);
    }
    const log = fs.openSync(path.join(ctx.dir, 'server.log'), 'w', 0o600);
    const budget = [];
    for (const [variable, flag, max] of [['TGREP_MAX_CPU', '--max-cpu', 100], ['TGREP_MAX_MEMORY_MB', '--max-memory', 1048576]]) {
      const value = process.env[variable];
      if (value) { if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${variable} must be 1..${max}`); budget.push(flag, value); }
    }
    child = spawn(binary, ['--index-path', ctx.index, '--max-filesize', '64M', 'serve', ctx.root, ...budget], { ...hidden, cwd: ctx.root, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    phase = 'running';
    child.once('error', e => { failure = e.message; });
    child.once('exit', (code, signal) => { if (!closing) { failure = `tgrep serve exited (${code ?? signal})`; atomicJSON(path.join(ctx.dir, 'last-error.json'), { error: failure, at: new Date().toISOString() }); shutdown(); } });
  } catch (e) {
    failure = e.message;
    atomicJSON(path.join(ctx.dir, 'last-error.json'), { error: failure, at: new Date().toISOString() });
    await sleep(1500);
    await shutdown();
  }
}
const switches = new Set('-i --ignore-case -s --case-sensitive -S --smart-case -F --fixed-strings -w --word-regexp -x --line-regexp -v --invert-match -l --files-with-matches --files-without-match -c --count -o --only-matching -q --quiet -n --line-number -N --no-line-number -H --with-filename -I --no-filename --json --files --column --trim --hidden --no-ignore --no-require-git --no-max-filesize -U --multiline --multiline-dotall -a --text --binary -L --follow --stats --no-index'.split(' '));
const values = new Set('-e --regexp -f --file -g --glob --iglob -t --type -T --type-not -m --max-count -A --after-context -B --before-context -C --context --color --max-filesize -E --encoding --max-depth --ignore-file'.split(' '));
function queryPath(value, cwd) {
  const resolved = path.resolve(cwd, value);
  // Windows 的短文件名和 junction 可指向同一工作树；与 canonical root 使用同一身份。
  // 只规范化可解析的实际路径，不把缺失/不可读路径换成父目录或扩大查询范围。
  if (process.platform === 'win32') {
    try { return canonical(resolved); } catch {}
  }
  return resolved;
}
function parse(argv, cwd = process.cwd()) {
  const command = argv.shift() || 'status';
  let root, fresh = false, positional = false;
  const options = [], positions = [], flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && arg === '--root') { if (!argv[i + 1]) throw new Error('--root needs a directory'); root = path.resolve(cwd, argv[++i]); continue; }
    if (!positional && arg === '--fresh') { fresh = true; continue; }
    if (!positional && switches.has(arg)) { flags.add(arg); if (arg !== '--no-index') options.push(arg); continue; }
    if (!positional && values.has(arg)) {
      flags.add(arg);
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      let value = argv[++i];
      if (['-f', '--file', '--ignore-file'].includes(arg)) value = path.resolve(cwd, value);
      options.push(arg, value); continue;
    }
    if (!positional && arg.startsWith('-')) throw new Error(`unsupported option ${arg}; use separate flags and '--' before pattern/path`);
    positions.push(arg);
  }
  const patternProvided = ['-e', '--regexp', '-f', '--file', '--files'].some(x => flags.has(x));
  const pattern = patternProvided ? [] : positions.splice(0, 1);
  const paths = (positions.length ? positions : [cwd]).map(x => queryPath(x, cwd));
  if (command === 'search' && !patternProvided && !pattern.length) throw new Error('search requires a pattern or --files');
  const widen = [...flags].some(x => ['--hidden', '--no-ignore', '--no-require-git', '--no-max-filesize', '--max-filesize', '-a', '--text', '--binary', '-L', '--follow', '-E', '--encoding', '--ignore-file', '--max-depth'].includes(x));
  return { command, root, fresh: fresh || widen || flags.has('--no-index'), flags, options, pattern, paths };
}
function searchArgs(query, ctx, scan, rg = false) {
  const options = [...query.options];
  if (rg && query.flags.has('--stats')) throw new Error('--stats cannot be mapped to rg with equivalent diagnostics');
  if (!query.flags.has('--max-filesize') && !query.flags.has('--no-max-filesize')) options.push('--max-filesize', '64M');
  if (rg) {
    for (let i = 0; i < options.length; i++) {
      if (values.has(options[i])) { i++; continue; }
      if (options[i] === '--no-max-filesize') { options.splice(i--, 1); continue; }
      if (options[i] === '-I') options[i] = '--no-filename';
    }
  } else options.push('--index-path', ctx.index, ...(scan ? ['--no-index'] : []));
  const aliases = { '-e': '--regexp', '-f': '--file', '-g': '--glob', '-t': '--type', '-T': '--type-not', '-m': '--max-count', '-A': '--after-context', '-B': '--before-context', '-C': '--context', '-E': '--encoding' };
  const args = [];
  for (let i = 0; i < options.length; i++) {
    if (values.has(options[i])) { const key = options[i]; args.push(`${aliases[key] || key}=${options[++i]}`); } else args.push(options[i]);
  }
  return [...args, ...query.pattern.map(p => `--regexp=${p}`), '--', ...query.paths];
}
function run(binary, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(binary, args, { ...hidden, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);
    const stdout = [], stderr = [];
    let size = 0, errSize = 0, failed;
    const timer = setTimeout(() => { failed = 'query timeout'; child.kill(); }, Math.max(1000, Number(process.env.TGREP_QUERY_TIMEOUT_MS) || 120000));
    child.stdout.on('data', data => { size += data.length; if (size > 32 * 1024 * 1024) { failed = 'query output exceeds 32 MiB; narrow the search'; child.kill(); } else stdout.push(data); });
    child.stderr.on('data', data => { errSize += data.length; if (errSize < 1024 * 1024) stderr.push(data); });
    child.on('error', e => { failed = e.message; });
    child.on('close', code => { activeChildren.delete(child); clearTimeout(timer); resolve({ code: failed ? 2 : code ?? 2, stdout: Buffer.concat(stdout), stderr: failed ? Buffer.from(`${failed}\n`) : Buffer.concat(stderr) }); });
  });
}
async function search(query, ctx) {
  maybeCheckUpdates();
  const state = ctx.git ? await managed(ctx, 'touch') : null;
  if (ctx.git && !state) start(ctx);
  ctx = updates.serviceBinding(ctx, state, selectedRelease());
  const queryRelease = updates.releaseForVersion(home(), ctx.version);
  const binary = executable(queryRelease);
  const haveBinary = installedHealthy(binary, queryRelease);
  const outside = query.paths.some(p => { const rel = path.relative(ctx.root, p); return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel); });
  const scan = query.fresh || outside || !ctx.git || state?.phase !== 'ready';
  const engine = haveBinary ? binary : 'rg';
  if (!haveBinary) process.stderr.write('[tgrep] runtime pending/unavailable; falling back to rg (ignore/encoding semantics can differ).\n');
  else if (scan && !query.fresh) process.stderr.write(`[tgrep] ${state?.phase || 'service unavailable'}; scanning disk.\n`);
  let result = await run(engine, searchArgs(query, ctx, scan, !haveBinary), ctx.root);
  const after = haveBinary && !scan ? await managed(ctx) : null;
  if (haveBinary && !scan && result.code !== 2 && (after?.id !== state?.id || after?.phase !== 'ready' || result.code === 1 || (result.code === 0 && result.stdout.length === 0))) {
    process.stderr.write('[tgrep] indexed query empty or service changed; verifying by disk scan.\n');
    result = await run(binary, searchArgs(query, ctx, true), ctx.root);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.code;
}
function maybeCheckUpdates() {
  try { updates.maybeCheck(module.exports); } catch {} // 更新调度失败不阻断既有搜索。
}
async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '_check-updates' || argv[0] === 'check-updates') {
    const result = await updates.checkUpdates(module.exports, { force: argv[0] === 'check-updates' });
    if (argv[0] === 'check-updates') console.log(JSON.stringify(result, null, 2));
    return result.outcome === 'error' ? 2 : 0;
  }
  if (argv[0] === '_supervise') return supervise(argv[1]);
  if (argv.length === 1 && argv[0] === '--help') { console.log('tgrep.cjs search [--root DIR] [--fresh] [-F] [-n] -- PATTERN [PATH...]\ntgrep.cjs ensure|status|doctor|stop [--root DIR]\ntgrep.cjs check-updates\nExit: 0 match/success; 1 no match; 2 error. Use separate flags; root controls service, paths retain cwd meaning.'); return 0; }
  const query = parse([...argv]);
  if (query.command === 'ensure') maybeCheckUpdates();
  const ctx = context(process.cwd(), query.root);
  if (!ctx) throw new Error('outside a Git worktree; provide --root DIR for an explicit disk scan');
  if (query.command === 'search') return search(query, ctx);
  if (query.command === 'ensure') {
    const binary = await ensureBinary();
    if (ctx.git && !await managed(ctx, 'touch')) start(ctx);
    console.log(JSON.stringify({ binary, root: ctx.root, state: ctx.git ? 'starting' : 'scan-only' })); return 0;
  }
  if (query.command === 'stop') {
    const state = await managed(ctx, 'stop');
    console.log(JSON.stringify({ stopped: Boolean(state), root: ctx.root })); return 0;
  }
  if (['status', 'doctor'].includes(query.command)) {
    const state = await managed(ctx);
    const binding = updates.serviceBinding(ctx, state, selectedRelease());
    const descriptor = updates.releaseForVersion(home(), binding.version);
    console.log(JSON.stringify({ root: ctx.root, index: binding.index, activeVersion: selectedRelease().version, serviceVersion: state ? binding.version : null, updates: updates.status(home()), binary: executable(descriptor), installed: installedHealthy(executable(descriptor), descriptor), state: state || { phase: ctx.git ? 'stopped' : 'scan-only' }, lastError: readJSON(path.join(ctx.dir, 'last-error.json')) }, null, 2)); return 0;
  }
  throw new Error(`unknown command: ${query.command}`);
}
module.exports = { atomicJSON, installedHealthy, selectedRelease, maybeCheckUpdates, parse, context, lock, rpc, managed, start, searchArgs, ensureBinary, executable, main, home, run };
if (require.main === module) main().then(code => { process.exitCode = code || 0; }).catch(e => { console.error(`[tgrep] ${e.message}`); process.exitCode = 2; });
