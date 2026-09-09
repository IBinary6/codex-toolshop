'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  MCP_BOOTSTRAP_BUDGET_MS,
  CRG_PACKAGE,
  crgRuntimePaths,
  installManagedCrg,
  probeCrgRuntime,
} = require('./bootstrap');
const { pluginDataDir } = require('./runtime');
const {
  activeRuntimeVersion,
  compareVersions,
  isRuntimeVersion,
  promoteRuntimeVersion,
  readRuntimeVersions,
} = require('./runtime-versions');
const {
  SERENA_MCP_ARGS,
  SERENA_VERSION,
  probeSerenaRuntime,
  serenaLaunchEnv,
  serenaRuntimePaths,
} = require('./serena-runtime');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATE_STATE_FILE = 'runtime-update-state.json';
const UPDATE_LOCK_FILE = 'runtime-update.lock';
const UPDATE_LOCK_STALE_MS = 30 * 60 * 1000;

function updateStatePath(options = {}) {
  return path.join(options.pluginDataDir || pluginDataDir(options), UPDATE_STATE_FILE);
}

function updateLockPath(options = {}) {
  return path.join(options.pluginDataDir || pluginDataDir(options), UPDATE_LOCK_FILE);
}

function readUpdateState(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(updateStatePath(options), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}

function writeUpdateState(value, options = {}) {
  const target = updateStatePath(options);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try { fs.renameSync(temporary, target); } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    throw error;
  }
}

function updatesDisabled(options = {}) {
  return String((options.env || process.env).CODEMAP_BOOST_DISABLE_RUNTIME_UPDATES || '') === '1';
}

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return !!error && error.code === 'EPERM'; }
}

function acquireUpdateLock(options = {}) {
  const file = options.lockPath || updateLockPath(options);
  const token = options.token || require('crypto').randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }), { flag: 'wx' });
    return { file, token };
  } catch (error) {
    if (!error || error.code !== 'EEXIST') return null;
  }
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (!isPidAlive(Number(record.pid)) && age > (options.lockStaleMs || UPDATE_LOCK_STALE_MS)) {
      fs.rmSync(file, { force: true });
      return acquireUpdateLock(options);
    }
  } catch (_) {}
  return null;
}

function releaseUpdateLock(lock) {
  if (!lock) return;
  try {
    const record = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
    if (record.token === lock.token) fs.rmSync(lock.file, { force: true });
  } catch (_) {}
}

function transferUpdateLock(lock, pid) {
  if (!lock || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    const record = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
    if (record.token !== lock.token) return false;
    fs.writeFileSync(lock.file, JSON.stringify({ ...record, pid }), 'utf8');
    return true;
  } catch (_) { return false; }
}

function recordScheduleError(options, reason) {
  try {
    const state = readUpdateState(options);
    writeUpdateState({ ...state, scheduler: { at: Date.now(), status: 'failed', reason: String(reason).slice(0, 600) } }, options);
  } catch (_) {}
}

function isUpdateDue(state, kind, now, force) {
  if (force) return true;
  const previous = Number(state && state.attempts && state.attempts[kind] && state.attempts[kind].at) || 0;
  return now - previous >= WEEK_MS;
}

function runtimeDir(kind, version, options = {}) {
  if (!isRuntimeVersion(version)) throw new Error(`非法候选版本：${version}`);
  const data = options.pluginDataDir || pluginDataDir(options);
  // CRG 的旧 crg-runtime 是 baseline。版本候选须放 sibling，避免其损坏修复删除候选。
  const name = kind === 'crg' ? 'crg-runtimes' : 'serena-runtime';
  return path.join(data, name, version);
}

function installedPackageVersion(paths, packageName, options = {}) {
  const executable = options.spawnSync || spawnSync;
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const requested = options.probeTimeout || 15000;
  const timeout = Number.isFinite(options.deadlineMs) ? Math.max(0, Math.min(requested, options.deadlineMs - now)) : requested;
  if (timeout <= 0) return '';
  try {
    const result = executable(paths.python, ['-I', '-B', '-c', `from importlib.metadata import version; print(version(${JSON.stringify(packageName)}))`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
      windowsHide: process.platform === 'win32',
    });
    const version = String(result && result.stdout || '').trim();
    return !result || result.error || result.status !== 0 || !isRuntimeVersion(version) ? '' : version;
  } catch (_) { return ''; }
}

function fetchPypiLatest(packageName, options = {}) {
  const get = options.httpsGet || https.get;
  const env = options.env || process.env;
  const timeout = options.networkTimeoutMs || 30000;
  const maxBytes = options.maxMetadataBytes || 1024 * 1024;
  const url = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;
  // curl 会遵循常见 HTTP(S)_PROXY 环境变量，适合受系统代理管理的宿主。
  if (!options.httpsGet && (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)) {
    try {
      const result = (options.curlSpawnSync || spawnSync)('curl', ['--fail', '--silent', '--show-error', '--max-time', String(Math.ceil(timeout / 1000)), url], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: maxBytes,
        windowsHide: process.platform === 'win32', env,
      });
      if (!result || result.error || result.status !== 0) throw new Error(String(result && (result.stderr || result.error && result.error.message) || 'curl PyPI request failed').trim());
      const version = JSON.parse(result.stdout).info.version;
      if (!isRuntimeVersion(version)) throw new Error(`PyPI 未返回稳定版本：${version}`);
      return Promise.resolve(version);
    } catch (error) { return Promise.reject(error); }
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    let request;
    try {
      request = get(url, { timeout }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body, 'utf8') > maxBytes) request.destroy(new Error('PyPI 元数据超过大小限制'));
        });
        response.on('end', () => {
          if (response.statusCode !== 200) return done(new Error(`PyPI HTTP ${response.statusCode}`));
          try {
            const version = JSON.parse(body).info.version;
            if (!isRuntimeVersion(version)) return done(new Error(`PyPI 未返回稳定版本：${version}`));
            done(null, version);
          } catch (error) { done(new Error(`PyPI 元数据无效：${error.message}`)); }
        });
      });
      request.once('error', (error) => done(error));
      request.once('timeout', () => request.destroy(new Error('PyPI 请求超时')));
    } catch (error) { done(error); }
  });
}

function checkCrgAdapter(paths, expectedVersion, options = {}) {
  const executable = options.spawnSync || spawnSync;
  const adapter = path.resolve(__dirname, '../../../scripts/refresh_graph.py');
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const requested = options.probeTimeout || 15000;
  const timeout = Number.isFinite(options.deadlineMs) ? Math.max(0, Math.min(requested, options.deadlineMs - now)) : requested;
  if (timeout <= 0) return { ok: false, reason: '候选验证预算已耗尽' };
  try {
    const result = executable(paths.python, ['-I', '-B', adapter, '--check-runtime'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
      windowsHide: process.platform === 'win32',
    });
    if (!result || result.error || result.status !== 0) return { ok: false, reason: String(result && (result.stderr || result.error && result.error.message) || 'refresh adapter failed').trim() };
    const response = JSON.parse(String(result.stdout || '').trim());
    if (!response || response.status !== 'ok') return { ok: false, reason: 'refresh adapter returned non-ok' };
    if (expectedVersion && String(response.crg_version || '') !== expectedVersion) return { ok: false, reason: `refresh adapter version mismatch: ${response.crg_version}` };
    return { ok: true };
  } catch (error) { return { ok: false, reason: error.message }; }
}

function verifySerenaCli(paths, options = {}) {
  const executable = options.spawnSync || spawnSync;
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const requested = options.probeTimeout || 30000;
  const timeout = Number.isFinite(options.deadlineMs) ? Math.max(0, Math.min(requested, options.deadlineMs - now)) : requested;
  if (timeout <= 0) return false;
  const script = [
    'import asyncio, json, sys',
    'from unittest.mock import patch',
    'from serena.agent import SerenaAgent',
    'from serena.cli import top_level',
    'from serena.mcp import SerenaMCPFactory',
    'original = SerenaMCPFactory.create_mcp_server',
    'original_agent_init = SerenaAgent.__init__',
    'def guarded_agent_init(self, *args, **kwargs):',
    "    config = kwargs.get('serena_config')",
    '    assert config is not None, "SerenaAgent config must be explicit before construction"',
    '    assert config.web_dashboard is False and config.web_dashboard_open_on_launch is False and config.gui_log_window is False',
    '    return original_agent_init(self, *args, **kwargs)',
    'def checked(self, *args, **kwargs):',
    '    server = original(self, *args, **kwargs)',
    '    config = self.agent.serena_config',
    '    assert self.project is None',
    '    assert config.web_dashboard is False and config.web_dashboard_open_on_launch is False and config.gui_log_window is False',
    "    assert getattr(self.agent, '_dashboard_manager', None) is None and getattr(self.agent, '_gui_log_viewer', None) is None",
    '    async def check_tools():',
    '        async with server.settings.lifespan(server):',
    '            tools = {tool.name: tool for tool in await server.list_tools()}',
    "            assert 'activate_project' in tools and 'find_symbol' in tools",
    "            assert 'project' in tools['activate_project'].inputSchema.get('properties', {})",
    "            assert 'name_path_pattern' in tools['find_symbol'].inputSchema.get('properties', {})",
    '    asyncio.run(check_tools())',
    '    return server',
    "with patch.object(SerenaAgent, '__init__', guarded_agent_init):",
    "    with patch.object(SerenaMCPFactory, 'create_mcp_server', checked):",
    "        with patch('serena.mcp.FastMCP.run', lambda *_args, **_kwargs: None):",
    "            top_level.main(args=json.loads(sys.argv[1]), prog_name='serena', standalone_mode=False)",
  ].join('\n');
  try {
    const result = executable(paths.python, ['-I', '-B', '-c', script, JSON.stringify(SERENA_MCP_ARGS)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
      windowsHide: process.platform === 'win32', env: serenaLaunchEnv({ ...options, runtimeDir: paths.dir }),
    });
    return !!result && !result.error && result.status === 0;
  } catch (_) { return false; }
}

function recordAttempt(state, kind, attempt) {
  const attempts = state.attempts && typeof state.attempts === 'object' ? { ...state.attempts } : {};
  attempts[kind] = attempt;
  return { ...state, attempts };
}

async function updateOne(kind, state, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (!isUpdateDue(state, kind, now, options.force)) return { state, result: { kind, status: 'not-due' } };
  const baseline = kind === 'crg' ? '' : SERENA_VERSION;
  const selected = activeRuntimeVersion(kind, options);
  const current = selected || (kind === 'crg'
    ? (options.currentCrgVersion || installedPackageVersion)(crgRuntimePaths(options), 'code-review-graph', options)
    : baseline);
  const packageName = kind === 'crg' ? 'code-review-graph' : 'serena-agent';
  try {
    const latest = await (options.fetchLatest || fetchPypiLatest)(packageName, options);
    if (!isRuntimeVersion(latest)) throw new Error(`候选版本无效：${latest}`);
    if (current && compareVersions(latest, current) <= 0) {
      const next = recordAttempt(state, kind, { at: now, status: 'no-change', current, latest });
      return { state: next, result: { kind, status: 'no-change', current, latest } };
    }
    const candidateDir = runtimeDir(kind, latest, options);
    const deadlineMs = now + MCP_BOOTSTRAP_BUDGET_MS;
    let installed = false;
    if (kind === 'crg') {
      const paths = crgRuntimePaths({ ...options, runtimeDir: candidateDir, version: latest });
      const crgProbe = options.probeCrg || probeCrgRuntime;
      const probe = (probeOptions) => crgProbe({ ...probeOptions, runtimeDir: candidateDir, expectedVersion: latest });
      installed = !!(options.installCrg || installManagedCrg)(`${CRG_PACKAGE}==${latest}`, { ...options, runtimeDir: candidateDir, version: latest, expectedVersion: latest, deadlineMs, probeRuntime: probe });
      if (installed && !probe({ ...options, deadlineMs })) installed = false;
      const adapter = (options.checkCrgAdapter || checkCrgAdapter)(paths, latest, { ...options, deadlineMs });
      if (installed && (!adapter || adapter.ok !== true)) {
        throw new Error(`CRG refresh adapter 验证失败：${adapter && adapter.reason || '未知原因'}`);
      }
    } else {
      const paths = serenaRuntimePaths({ ...options, runtimeDir: candidateDir, version: latest });
      const serenaProbe = options.probeSerena || probeSerenaRuntime;
      const probe = (probeOptions) => serenaProbe({ ...probeOptions, runtimeDir: candidateDir, version: latest, expectedVersion: latest });
      installed = !!(options.installSerena || installManagedCrg)(`serena-agent==${latest}`, { ...options, runtimeDir: candidateDir, version: latest, expectedVersion: latest, deadlineMs, probeRuntime: probe });
      if (installed && !probe({ ...options, deadlineMs })) installed = false;
      if (installed && !(options.verifySerenaCli || verifySerenaCli)(paths, { ...options, deadlineMs })) installed = false;
    }
    if (!installed) throw new Error('候选运行时健康或兼容性验证未通过');
    (options.promote || promoteRuntimeVersion)(kind, latest, options);
    const next = recordAttempt(state, kind, { at: now, status: 'promoted', current, latest });
    return { state: next, result: { kind, status: 'promoted', current, latest } };
  } catch (error) {
    const next = recordAttempt(state, kind, { at: now, status: 'failed', current, reason: String(error.message || error).slice(0, 600) });
    return { state: next, result: { kind, status: 'failed', current, reason: next.attempts[kind].reason } };
  }
}

async function runRuntimeUpdates(options = {}) {
  if (updatesDisabled(options)) return { status: 'disabled', results: [] };
  const lock = options.lock || acquireUpdateLock(options);
  if (!lock) return { status: 'busy', results: [] };
  try {
    let state = readUpdateState(options);
    const results = [];
    for (const kind of ['crg', 'serena']) {
      const output = await updateOne(kind, state, options);
      state = output.state;
      results.push(output.result);
      writeUpdateState(state, options);
    }
    return { status: results.some((item) => item.status === 'failed') ? 'partial' : 'ok', results, state };
  } finally { releaseUpdateLock(lock); }
}

function runtimeUpdateDoctor(options = {}) {
  const crgSelected = activeRuntimeVersion('crg', options) || 'legacy-crg-runtime';
  const serenaSelected = activeRuntimeVersion('serena', options) || SERENA_VERSION;
  const crgPaths = crgRuntimePaths(options);
  const serenaPaths = serenaRuntimePaths(options);
  const runtimes = {
    crg: { selected: crgSelected, installed: installedPackageVersion(crgPaths, 'code-review-graph', options) || null, runtimeDir: crgPaths.dir, command: crgPaths.command },
    serena: { selected: serenaSelected, installed: installedPackageVersion(serenaPaths, 'serena-agent', options) || null, runtimeDir: serenaPaths.dir, command: serenaPaths.command },
  };
  const versions = readRuntimeVersions(options);
  const state = readUpdateState(options);
  return {
    disabled: updatesDisabled(options),
    runtimes,
    versions,
    attempts: state.attempts || {},
    statePath: updateStatePath(options),
    versionsPath: require('./runtime-versions').runtimeVersionsPath(options),
  };
}

function scheduleRuntimeUpdates(options = {}) {
  if (updatesDisabled(options)) return false;
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const state = readUpdateState(options);
  if (!isUpdateDue(state, 'crg', now, false) && !isUpdateDue(state, 'serena', now, false)) return false;
  const lock = acquireUpdateLock(options);
  if (!lock) return false;
  const script = path.resolve(__dirname, '../../../scripts/runtime-update.cjs');
  try {
    const fail = (reason) => {
      recordScheduleError(options, reason);
      releaseUpdateLock(lock);
      return false;
    };
    const child = (options.spawn || spawn)(options.nodeCommand || process.execPath, [script, '--background', '--lock-token', lock.token], {
      detached: true, stdio: 'ignore', windowsHide: process.platform === 'win32',
      env: { ...process.env, ...(options.env || {}), PLUGIN_DATA: path.resolve(options.pluginDataDir || pluginDataDir(options)) },
    });
    if (!child || typeof child.once !== 'function') return fail('后台更新器未返回可监听的子进程');
    // spawn 可能先返回 ChildProcess、之后才异步触发 error；必须在检查 pid 前订阅。
    child.once('error', (error) => {
      recordScheduleError(options, error && error.message || error || '后台更新器启动失败');
      releaseUpdateLock(lock);
    });
    if (!Number.isInteger(Number(child.pid)) || Number(child.pid) <= 0) return fail('后台更新器未获得有效进程 PID');
    if (!transferUpdateLock(lock, Number(child.pid))) return fail('后台更新器安装锁移交失败');
    if (typeof child.unref !== 'function') return fail('后台更新器不支持 detached unref');
    child.unref();
    return true;
  } catch (error) {
    recordScheduleError(options, error && error.message || error || '后台更新器启动异常');
    releaseUpdateLock(lock);
    return false;
  }
}

function adoptedUpdateLock(token, options = {}) {
  if (!token) return null;
  const file = options.lockPath || updateLockPath(options);
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record.token === token && Number(record.pid) === process.pid ? { file, token } : null;
  } catch (_) { return null; }
}

module.exports = {
  UPDATE_LOCK_FILE, UPDATE_STATE_FILE, WEEK_MS,
  acquireUpdateLock, adoptedUpdateLock, checkCrgAdapter, compareVersions,
  fetchPypiLatest, isUpdateDue, readUpdateState, releaseUpdateLock,
  runRuntimeUpdates, runtimeDir, runtimeUpdateDoctor, scheduleRuntimeUpdates, installedPackageVersion,
  updateLockPath, updateStatePath, updatesDisabled, verifySerenaCli, writeUpdateState,
  recordScheduleError, transferUpdateLock,
};
