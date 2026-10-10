'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { SafeError, configPath, readConfig, createConfig } = require('./config.cjs');
const { ChildTransport } = require('./child-transport.cjs');
const catalog = require('./catalog.json');
const MAX = 8 * 1024 * 1024;
const CTX7_VERSION = '0.6.0';
const SUPPORTED = ['context7', 'exa', 'tavily'];
const cancelled = () => new SafeError('调用已取消或超时。');

function redact(value, key) {
  if (typeof value === 'string') {
    for (const variant of key ? new Set([key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2)]) : []) value = value.split(variant).join('[REDACTED]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [redact(name, key), redact(item, key)]));
  return value;
}

function waitFor(promise, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function delay(ms, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readJson(response, signal) {
  if (!response.body) throw new SafeError('官方服务返回空响应。');
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await waitFor(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX) throw new SafeError('官方响应超过 8 MiB 限制。');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new SafeError('官方响应 JSON 格式无效。'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// PATH 只用于定位 npm 的实际 JS 入口；用户查询不会进入 shell 或 npm 参数字符串。
function findNpm(env = process.env, node = process.execPath) {
  const directories = [path.dirname(node), ...(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)];
  for (const directory of directories) {
    const candidates = [path.join(directory, 'node_modules/npm/bin/npm-cli.js'), path.join(directory, '../lib/node_modules/npm/bin/npm-cli.js')];
    for (const name of ['npm', 'npm.cmd']) {
      try {
        const real = fs.realpathSync(path.join(directory, name));
        if (real.endsWith('npm-cli.js')) candidates.push(real);
      } catch {}
    }
    for (const file of candidates) { try { if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch {} }
  }
  throw new SafeError('Context7 需要带 npm 的 Node.js ≥22.13.0；请安装后重试。');
}

function runProcess(command, args, options) {
  const { signal } = options;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let child;
    try { child = (options.spawn || spawn)(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }); }
    catch { reject(new SafeError('Context7 官方命令无法启动。')); return; }
    const owner = new ChildTransport('context7', async () => {});
    const output = [];
    let bytes = 0, failure;
    const terminate = () => owner.terminate(child);
    const abort = () => { failure = cancelled(); terminate(); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => {
      bytes += data.byteLength;
      if (bytes > MAX) { failure = new SafeError('Context7 响应超过 8 MiB 限制。'); terminate(); }
      else output.push(Buffer.from(data));
    });
    child.stderr.on('data', () => {});
    child.once('error', () => { signal.removeEventListener('abort', abort); reject(new SafeError('Context7 官方命令无法启动；请检查 Node/npm。')); });
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new SafeError('Context7 官方命令失败；请检查私有配置、参数或网络。'));
      else resolve(Buffer.concat(output).toString('utf8'));
    });
  });
}

function ctx7Args(name, args) {
  const docs = name === 'query-docs';
  const command = docs ? 'docs' : 'library';
  const flags = ['--json'];
  if (docs && args.language !== undefined) flags.push('--language', args.language);
  return [command, ...flags, '--', docs ? args.libraryId : args.libraryName, args.query];
}

function runtimeDirectory(env) {
  const root = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (!path.isAbsolute(root)) throw new SafeError('Context7 runtime 根目录必须是绝对路径。');
  return path.join(root, 'context7-codex/runtime');
}

function exaSearchBody(args) {
  let category;
  const query = typeof args.query === 'string' ? args.query.replace(/(^|\s)category:(people|company)(?=\s|$)/g, (_, prefix, value) => {
    if (category && category !== value) throw new SafeError('Exa query 只能指定一种 category:people 或 category:company。');
    category = value;
    return '';
  }) : args.query;
  // objective 保持既有语义，以调用者的原始 query 补缺省值；只有搜索 query 移除控制标记。
  return { ...args, query: category ? query.trim() : query, objective: args.objective ?? args.query?.slice(0, 4096),
    ...(category ? { category } : {}), contents: { highlights: true } };
}

async function context7(params, key, env, signal, options) {
  if (signal.aborted) throw cancelled();
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 13) throw new SafeError('ctx7 0.6.0 需要 Node.js ≥22.13.0。');
  const runtime = runtimeDirectory(env);
  const root = path.join(runtime, 'official-cli');
  const entry = path.join(root, 'node_modules/ctx7/dist/index.js');
  const childEnv = { ...env, CONTEXT7_API_KEY: '', CTX7_TELEMETRY_DISABLED: '1', npm_config_cache: path.join(runtime, 'npm-cache'), XDG_CONFIG_HOME: path.join(runtime, 'config'), XDG_STATE_HOME: path.join(runtime, 'state'), XDG_CACHE_HOME: path.join(runtime, 'cache') };
  // 固定发布版源码支持这些 XDG 路径；已有目标文件阻止其迁移宿主 legacy 凭据和状态。
  for (const [file, value] of [[path.join(childEnv.XDG_CONFIG_HOME, 'context7/credentials.json'), {}], [path.join(childEnv.XDG_STATE_HOME, 'context7/cli-state.json'), { lastCheckedAt: Date.now(), latestVersion: CTX7_VERSION }]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw new SafeError('Context7 隔离 runtime 无法创建。'); }
  }
  let installed = false;
  try { installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/ctx7/package.json'), 'utf8')).version === CTX7_VERSION && fs.existsSync(entry); } catch {}
  const run = options.runProcess || runProcess;
  if (!installed) {
    const npm = (options.findNpm || findNpm)(env);
    await run(process.execPath, [npm, 'install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `ctx7@${CTX7_VERSION}`], { env: childEnv, signal });
  }
  const text = await run(process.execPath, [entry, ...ctx7Args(params.name, params.arguments)], { env: { ...childEnv, CONTEXT7_API_KEY: key }, signal });
  try { return JSON.parse(text); } catch { throw new SafeError('Context7 官方 JSON 输出无效或没有匹配结果。'); }
}

class CommandClient {
  constructor(provider, options = {}) {
    if (!SUPPORTED.includes(provider)) throw new SafeError('命令提供方无效。');
    this.provider = provider;
    this.options = options;
    this.env = options.env || process.env;
    this.file = options.configFile || configPath(this.env, undefined, provider);
    this.fetch = options.fetch || globalThis.fetch;
    this.timeout = Number(options.timeoutMs ?? this.env.RESEARCH_TOOLS_TIMEOUT_MS ?? 120000);
    if (!Number.isFinite(this.timeout) || this.timeout < 1 || this.timeout > 180000) throw new SafeError('调用超时必须在 1–180000 毫秒之间。');
    this.controllers = new Set();
  }

  async request(endpoint, body, key, signal, get = false) {
    const headers = { 'Content-Type': 'application/json', ...(this.provider === 'exa' ? { 'x-api-key': key } : { Authorization: `Bearer ${key}` }) };
    let response;
    try { response = await waitFor(this.fetch(`https://api.${this.provider === 'exa' ? 'exa.ai' : 'tavily.com'}/${endpoint}`, { method: get ? 'GET' : 'POST', headers, ...(get ? {} : { body: JSON.stringify(body) }), signal, redirect: 'error' }), signal); }
    catch { throw signal.aborted ? cancelled() : new SafeError(`${this.provider} 官方 API 连接失败。`); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new SafeError(`${this.provider} 官方 API HTTP ${response.status}；请检查配置、参数或用量。`); }
    return readJson(response, signal);
  }

  async call(params, parentSignal) {
    const tool = catalog.providers[this.provider].find(tool => tool.name === params?.name);
    if (!tool) throw new SafeError('命令名称无效。');
    const args = params.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new SafeError('arguments 必须是 JSON 对象。');
    if (Object.keys(args).some(name => ['apiKey', 'api_key', 'Authorization'].includes(name))) throw new SafeError('密钥只能填写在本插件私有配置中。');
    const research = this.provider === 'tavily' && params.name === 'tavily_research' ? params.research : undefined;
    if (research !== undefined && (!research || typeof research !== 'object' || Array.isArray(research))) throw new SafeError('research 控制项必须是 JSON 对象。');
    if (research?.wait !== undefined && typeof research.wait !== 'boolean') throw new SafeError('research.wait 必须是布尔值。');
    const resume = research?.requestId;
    if (resume !== undefined && (typeof resume !== 'string' || !/^[\w-]{1,256}$/.test(resume))) throw new SafeError('研究 requestId 无效。');
    if (!resume) for (const name of tool.inputSchema.required || []) if (!Object.hasOwn(args, name)) throw new SafeError(`缺少参数 ${name}。`);
    if (this.provider === 'context7') {
      for (const name of ['query', params.name === 'query-docs' ? 'libraryId' : 'libraryName']) if (typeof args[name] !== 'string' || !args[name]) throw new SafeError(`${name} 必须是非空字符串。`);
      if (args.language !== undefined && typeof args.language !== 'string') throw new SafeError('language 必须是字符串。');
    }
    if (parentSignal?.aborted) throw cancelled();
    createConfig(this.file, this.provider);
    const key = readConfig(this.file, this.provider)[this.provider].apiKey;
    if (this.provider !== 'context7' && !key) throw new SafeError(`${this.provider} 尚未配置 apiKey；请运行本插件 setup 并编辑私有配置。`);
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    if (parentSignal?.aborted) abort();
    const timer = setTimeout(abort, this.timeout);
    let requestId;
    try {
      const signal = controller.signal;
      let result;
      if (this.provider === 'context7') result = await context7(params, key, this.env, signal, this.options);
      else if (this.provider === 'exa') {
        const search = params.name === 'web_search_exa';
        const body = search ? exaSearchBody(args) : { ids: args.urls, text: { maxCharacters: args.maxCharacters ?? 3000 } };
        result = await this.request(search ? 'search' : 'contents', body, key, signal);
      } else {
        const endpoint = params.name.slice('tavily_'.length);
        if (endpoint !== 'research') result = await this.request(endpoint, args, key, signal);
        else {
          const job = resume ? { request_id: resume, status: 'pending' } : await this.request('research', { ...args, stream: false }, key, signal);
          if (typeof job?.request_id !== 'string' || !/^[\w-]{1,256}$/.test(job.request_id)) throw new SafeError('研究任务响应缺少有效 request_id。');
          requestId = job.request_id;
          result = job;
          if (params.research?.wait !== false) while (['pending', 'in_progress'].includes(result?.status)) {
            await delay(this.options.pollMs ?? 2000, signal);
            result = await this.request(`research/${encodeURIComponent(requestId)}`, undefined, key, signal, true);
          }
          if (params.research?.wait !== false && !['completed', 'failed'].includes(result?.status)) throw new SafeError('研究任务返回未知状态；请按 request_id 稍后查询。');
        }
      }
      const safe = redact(result, key);
      return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }], structuredContent: safe, ...(safe?.status === 'failed' ? { isError: true } : {}) };
    } catch (error) {
      // 只有已验证的 ID 才可恢复；HTTP、网络、解析和未知状态等轮询失败
      // 都保留恢复入口。短命 CLI 必须将此 JSON 输出并以失败状态退出。
      if (requestId) {
        const message = controller.signal.aborted ? cancelled().message : error instanceof SafeError ? error.message : '研究任务查询失败。';
        const safe = redact({ request_id: requestId, status: 'pending', resume: true, error: message }, key);
        return { content: [{ type: 'text', text: safe.error + ' 可用 request_id 继续查询；恢复只发送 GET。' }], structuredContent: safe, isError: true };
      }
      if (error instanceof SafeError) throw error;
      throw controller.signal.aborted ? cancelled() : new SafeError(`${this.provider} 调用失败。`);
    } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); this.controllers.delete(controller); }
  }

  close() { for (const controller of this.controllers) controller.abort(); }
}

module.exports = { CommandClient, SUPPORTED, MAX, CTX7_VERSION, readJson, runProcess, findNpm, ctx7Args, redact };
