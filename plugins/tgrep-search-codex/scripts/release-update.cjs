'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const fallback = require('./release.json');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const API_URL = 'https://api.github.com/repos/microsoft/tgrep/releases/latest';
const targets = {
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
};
const platformKey = () => `${process.platform}-${process.arch}`;
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('unsupported stable version');
  const parts = version.split('.').map(Number);
  if (parts.some(x => !Number.isSafeInteger(x))) throw new Error('invalid version number');
  return parts;
}
function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
function validateRelease(release, key = platformKey()) {
  versionParts(release?.version);
  const asset = release.assets?.[key];
  if (!targets[key] || !asset) throw new Error(`release has no supported asset for ${key}`);
  if (!/^[a-f0-9]{64}$/.test(asset.sha256 || '')) throw new Error('official asset SHA256 digest missing');
  const extension = key.startsWith('win32-') ? '.zip' : '.tar.gz';
  const tag = release.tag || `v${release.version}`;
  if (tag !== release.version && tag !== `v${release.version}`) throw new Error('release tag/version mismatch');
  const name = `tgrep-${tag}-${targets[key]}${extension}`;
  const expected = `https://github.com/microsoft/tgrep/releases/download/${tag}/${name}`;
  if (asset.archive !== name || asset.url !== expected || asset.executable !== (key.startsWith('win32-') ? 'tgrep.exe' : 'tgrep')) throw new Error('unsupported official release asset URL/name');
  return release;
}
function fromLatest(json, key = platformKey()) {
  if (json?.draft !== false || json.prerelease !== false) throw new Error('latest release is not stable');
  const version = String(json.tag_name || '').replace(/^v/, '');
  versionParts(version);
  const suffix = key.startsWith('win32-') ? '.zip' : '.tar.gz';
  const name = `tgrep-${json.tag_name}-${targets[key]}${suffix}`;
  const asset = json.assets?.find(x => x.name === name);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error('official asset or SHA256 digest missing; active release retained');
  return validateRelease({ version, tag: json.tag_name, assets: { [key]: { archive: name, url: asset.browser_download_url, sha256: asset.digest.slice(7), executable: key.startsWith('win32-') ? 'tgrep.exe' : 'tgrep' } } }, key);
}
function activeRelease(home) {
  const selected = read(path.join(home, 'active-release.json'));
  try {
    if (selected && compareVersions(selected.version, fallback.version) >= 0) return validateRelease(selected);
  } catch {}
  return fallback;
}
function releaseForVersion(home, version) {
  if (version === fallback.version) return fallback;
  versionParts(version);
  const found = read(path.join(home, 'runtime', version, platformKey(), 'release.json'));
  if (!found || found.version !== version) throw new Error(`managed service release ${version} is unavailable`);
  return validateRelease(found);
}
function indexForVersion(dir, version) { versionParts(version); return path.join(dir, 'indexes', version); }
// 旧 manager 没有版本字段，必须沿用其 1.0.5 二进制和旧 index，而非读 active 指针。
function serviceBinding(ctx, state, selected) {
  if (!state) return { ...ctx, version: selected.version, index: indexForVersion(ctx.dir, selected.version) };
  const version = state.version || fallback.version;
  versionParts(version);
  const index = state.version ? indexForVersion(ctx.dir, version) : path.join(ctx.dir, 'index');
  if (state.index && path.resolve(state.index) !== path.resolve(index)) throw new Error('managed service index/version mismatch');
  return { ...ctx, version, index };
}
function due(state, now = Date.now()) {
  return !Number.isFinite(state?.lastChecked) || now - state.lastChecked >= WEEK_MS;
}
function status(home) { return read(path.join(home, 'update-status.json')); }
function maybeCheck(api) {
  if (process.env.TGREP_DISABLE_UPDATES === '1') return;
  const home = api.home();
  if (!due(status(home))) return;
  const unlock = api.lock(path.join(home, 'update-schedule.lock'));
  if (!unlock) return;
  try {
    const requestFile = path.join(home, 'update-request.json');
    const previous = read(requestFile);
    if (!due(status(home)) || (previous && Date.now() - previous.at < 5 * 60 * 1000)) return;
    api.atomicJSON(requestFile, { at: Date.now() });
    const child = spawn(process.execPath, [path.join(__dirname, 'tgrep.cjs'), '_check-updates'], { detached: true, stdio: 'ignore', windowsHide: true, shell: false, env: process.env });
    child.on('error', error => api.atomicJSON(path.join(home, 'update-status.json'), { lastChecked: Date.now(), outcome: 'error', error: error.message }));
    child.unref();
  } finally { unlock(); }
}
async function fetchHttps(url, { timeout = 90000, headers } = {}) {
  const deadline = Date.now() + timeout;
  for (let redirect = 0; redirect < 6; redirect++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('non-HTTPS release redirect refused');
    const response = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('release redirect has no location');
    url = new URL(location, target).href;
  }
  throw new Error('too many release redirects');
}
async function fetchLatest(api) {
  const result = await api.run('curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--silent', '--show-error', '--connect-timeout', '10', '--max-time', '30', '-H', 'Accept: application/vnd.github+json', '-H', 'User-Agent: codex-tgrep-search', API_URL], api.home());
  if (result.code === 0) return JSON.parse(result.stdout.toString());
  if (!result.stderr.toString().includes('ENOENT')) throw new Error(`latest release check failed: ${result.stderr}`);
  const response = await fetchHttps(API_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'codex-tgrep-search' }, timeout: 30000 });
  if (!response.ok) throw new Error(`latest release HTTP ${response.status}`);
  return response.json();
}
// 使用系统临时目录中的自有 fixture。验证不会读取或重建用户工作树索引。
async function validateCandidate(api, binary, release) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tgrep-upgrade-'));
  const root = path.join(fixture, 'repo'), index = path.join(fixture, 'index');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'sample.txt'), 'candidate-first-marker\n');
  let child;
  try {
    async function command(args, expected = 0) {
      const result = await api.run(binary, args, root);
      if (result.code !== expected) throw new Error(`candidate CLI failed (${result.code}): ${result.stderr}`);
      return result.stdout.toString();
    }
    const version = await command(['--version']);
    if (version.trim() !== `tgrep ${release.version}`) throw new Error('candidate version output mismatch');
    await command(['--help']);
    await command(['--index-path', index, '--max-filesize', '64M', 'index', root]);
    child = spawn(binary, ['--index-path', index, '--max-filesize', '64M', 'serve', root], { cwd: root, windowsHide: true, shell: false, stdio: 'ignore' });
    let launchError;
    child.on('error', error => { launchError = error; });
    let ready = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (launchError || child.exitCode !== null || child.signalCode !== null) throw new Error(`candidate serve failed: ${launchError?.message || child.exitCode || child.signalCode}`);
      const discovery = read(path.join(index, 'serve.json'));
      if (discovery?.pid === child.pid) {
        try {
          const reply = await api.rpc(discovery.port, { jsonrpc: '2.0', method: 'status', id: 1 });
          const value = reply.result;
          ready = value?.indexing === false && value.reconcile_running === false && value.reconcile_pending === false && value.reconcile_overdue === false && Number.isFinite(value.last_reconcile_at) && !value.last_reconcile_error && ['native', 'poll'].includes(value.watch_mode_active);
        } catch {}
      }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('candidate status/reconcile protocol incompatible or timed out');
    const query = ['--index-path', index, '--max-filesize', '64M', '-F', '-n', '--regexp=candidate-first-marker', '--', root];
    if (!(await command(query)).includes('candidate-first-marker')) throw new Error('candidate indexed search incompatible');
    await command(['--index-path', index, '--max-filesize', '64M', '--regexp=candidate-absent-marker', '--', root], 1);
    const files = await command(['--index-path', index, '--files', '--', root]);
    if (!files.includes('sample.txt')) throw new Error('candidate file listing incompatible');
    fs.writeFileSync(path.join(root, 'sample.txt'), 'candidate-fresh-marker\n');
    if (!(await command(['--index-path', index, '--max-filesize', '64M', '--no-index', '-F', '--regexp=candidate-fresh-marker', '--', root])).includes('candidate-fresh-marker')) throw new Error('candidate fresh search incompatible');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      }
      if (child.exitCode === null && child.signalCode === null) throw new Error('candidate child did not exit; active release retained');
    }
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
async function checkUpdates(api, { force = false, fetchRelease = () => fetchLatest(api), validate = (binary, candidate) => validateCandidate(api, binary, candidate) } = {}) {
  const home = api.home();
  if (!force && process.env.TGREP_DISABLE_UPDATES === '1') return { outcome: 'disabled' };
  if (!force && !due(status(home))) return { ...status(home), skipped: true };
  const unlock = api.lock(path.join(home, 'update-check.lock'));
  if (!unlock) return { outcome: 'pending' };
  const lastChecked = Date.now();
  try {
    if (!force && !due(status(home))) return { ...status(home), skipped: true };
    const current = activeRelease(home);
    api.atomicJSON(path.join(home, 'update-status.json'), { lastChecked, currentVersion: current.version, outcome: 'checking' });
    try {
      const json = await fetchRelease();
      const latestVersion = String(json?.tag_name || '').replace(/^v/, '');
      versionParts(latestVersion);
      if (json.draft !== false || json.prerelease !== false) throw new Error('latest release is not stable');
      if (compareVersions(latestVersion, current.version) <= 0) {
        const result = { lastChecked, completedAt: Date.now(), currentVersion: current.version, latestVersion, outcome: 'unchanged', error: null };
        api.atomicJSON(path.join(home, 'update-status.json'), result); return result;
      }
      const candidate = fromLatest(json);
      const binary = await api.ensureBinary(candidate);
      await validate(binary, candidate);
      if (compareVersions(candidate.version, activeRelease(home).version) > 0) api.atomicJSON(path.join(home, 'active-release.json'), candidate);
      const result = { lastChecked, completedAt: Date.now(), currentVersion: activeRelease(home).version, latestVersion, outcome: 'updated', error: null };
      api.atomicJSON(path.join(home, 'update-status.json'), result); return result;
    } catch (error) {
      const result = { lastChecked, completedAt: Date.now(), currentVersion: activeRelease(home).version, outcome: 'error', error: error.message };
      api.atomicJSON(path.join(home, 'update-status.json'), result); return result;
    }
  } finally { unlock(); }
}
module.exports = { fetchHttps, WEEK_MS, API_URL, fallback, platformKey, compareVersions, validateRelease, fromLatest, activeRelease, releaseForVersion, indexForVersion, serviceBinding, due, status, maybeCheck, checkUpdates, validateCandidate };
