'use strict';

const readline = require('node:readline');
const { PROVIDERS, SafeError, configPath, readConfig, createConfig } = require('./config.cjs');
const { ChildTransport } = require('./child-transport.cjs');
const PROTOCOL = '2025-06-18';
const { version: VERSION, name: SERVER_NAME, researchToolsProvider: PACKAGE_PROFILE } = require('../package.json');
const REMOTE_PROVIDERS = [...PROVIDERS, 'microsoft'];
const LOCAL_PROVIDERS = ['fetch', 'sequentialthinking'];
const MAX_BODY = 8 * 1024 * 1024;
const ENDPOINTS = {
  context7: 'https://mcp.context7.com/mcp',
  exa: 'https://mcp.exa.ai/mcp',
  tavily: 'https://mcp.tavily.com/mcp/',
  microsoft: 'https://learn.microsoft.com/api/mcp'
};

class HttpError extends SafeError {
  constructor(provider, status) { super(`${provider} remote HTTP ${status}; check private configuration or retry later.`); this.status = status; }
}

function aborted() { return new SafeError('Research Tools call was cancelled or timed out.'); }
function waitFor(promise, signal) {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

// Remote results may echo received credentials; sanitize every string before returning to the MCP client.
function redact(value, secrets) {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
      for (const variant of new Set([secret, encodeURIComponent(secret), new URLSearchParams({ k: secret }).toString().slice(2)])) {
        result = result.split(variant).join('[REDACTED]');
      }
    }
    return result.replace(/([?&]tavilyApiKey=)[^\s&#"<>]*/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), redact(item, secrets)]));
  return value;
}

// Parse SSE incrementally by event; cancel reading after the target response without waiting for the persistent stream to close.
async function readRpc(response, id, signal) {
  if (!response.body) throw new SafeError('Remote MCP returned an empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = /text\/event-stream/i.test(response.headers.get('content-type') || '');
  let buffer = '', size = 0;
  const match = text => {
    let value;
    try { value = JSON.parse(text); } catch { throw new SafeError('Remote MCP response has invalid format.'); }
    const values = Array.isArray(value) ? value : [value];
    return values.find(item => item && item.id === id && item.jsonrpc === '2.0');
  };
  try {
    while (true) {
      const { value, done } = await waitFor(reader.read(), signal);
      if (value) {
        size += value.byteLength;
        if (size > MAX_BODY) throw new SafeError('Remote MCP response exceeds the size limit.');
        buffer += decoder.decode(value, { stream: true });
      }
      if (sse) {
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (data) { const result = match(data); if (result) return result; }
        }
      }
      if (done) {
        buffer += decoder.decode();
        if (!sse) { const result = match(buffer); if (result) return result; }
        throw new SafeError('Remote MCP did not return a result for this request.');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class Gateway {
  constructor(options = {}) {
    if (PACKAGE_PROFILE !== undefined && options.provider !== undefined && options.provider !== PACKAGE_PROFILE) throw new SafeError('This plugin can use only its own provider.');
    this.provider = options.provider ?? PACKAGE_PROFILE;
    const available = [...REMOTE_PROVIDERS, ...LOCAL_PROVIDERS];
    if (this.provider !== undefined && !available.includes(this.provider)) throw new SafeError('Invalid Research Tools provider name.');
    this.providers = this.provider === undefined ? available : [this.provider];
    this.fetch = options.fetch || globalThis.fetch;
    this.env = options.env || process.env;
    this.file = options.configFile || configPath(this.env, undefined, this.provider);
    createConfig(this.file, this.provider);
    this.catalog = options.catalog || require('./catalog.json');
    this.endpoints = options.endpoints || ENDPOINTS;
    const requested = Number(options.timeoutMs ?? this.env.RESEARCH_TOOLS_TIMEOUT_MS ?? 120000);
    if (!Number.isFinite(requested) || requested < 1 || requested > 180000) throw new SafeError('Research Tools timeout must be between 1 and 180000 milliseconds.');
    this.timeoutMs = requested;
    this.states = new Map();
    this.controllers = new Set();
    this.nextId = 1;
    this.closed = false;
    this.local = new Map();
    this.createLocal = options.createLocal || (provider => provider === 'sequentialthinking'
      ? new (require('./sequential-core.cjs').SequentialCore)()
      : new ChildTransport(provider, signal => require('./local-backends.cjs').launch(provider, this.env, signal)));
    this.tools = [];
    this.routes = new Map();
    for (const provider of this.providers) {
      const entries = this.catalog.providers?.[provider];
      if (!Array.isArray(entries)) throw new SafeError('Invalid local Research Tools catalog.');
      for (const tool of entries) {
        if (this.routes.has(tool.name)) throw new SafeError('Duplicate local Research Tools tool name.');
        this.routes.set(tool.name, provider);
        this.tools.push(tool);
      }
    }
  }

  operation(parentSignal) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    if (parentSignal?.aborted || this.closed) abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    return { signal: controller.signal, finish: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    } };
  }

  state(provider, key) {
    let state = this.states.get(provider);
    if (!state || state.key !== key) {
      // Existing calls keep their credential snapshot; new calls reuse only sessions with the new credentials.
      state = { provider, key, session: undefined, protocol: PROTOCOL, initializing: undefined, initialized: false };
      this.states.set(provider, state);
    }
    return state;
  }

  async request(state, method, params, signal, notification = false) {
    if (signal.aborted) throw aborted();
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': 'Mozilla/5.0' };
    if (state.provider === 'context7' && state.key) headers.Authorization = `Bearer ${state.key}`;
    if (state.provider === 'exa' && state.key) headers['x-api-key'] = state.key;
    if (state.session) headers['Mcp-Session-Id'] = state.session;
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = state.protocol;
    const url = new URL(this.endpoints[state.provider]);
    if (state.provider === 'tavily') url.searchParams.set('tavilyApiKey', state.key);
    const id = notification ? undefined : this.nextId++;
    let response;
    try {
      response = await this.fetch(url.toString(), { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }), signal });
    } catch { throw signal.aborted ? aborted() : new SafeError(`${state.provider} remote connection failed; retry later.`); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new HttpError(state.provider, response.status); }
    if (notification) { await response.body?.cancel().catch(() => {}); return; }
    const session = response.headers.get('Mcp-Session-Id');
    if (session) state.session = session;
    const rpc = await readRpc(response, id, signal);
    if (rpc.error) throw new SafeError(`${state.provider} remote MCP request failed; check arguments or private configuration.`);
    if (!Object.hasOwn(rpc, 'result')) throw new SafeError(`${state.provider} remote MCP response lacks a result.`);
    return rpc.result;
  }

  async initialize(state, callerSignal) {
    if (state.initialized) return;
    if (!state.initializing) {
      // Initialization has its own timeout and gateway lifetime; cancelling one call does not cancel another call's shared handshake.
      const operation = this.operation();
      state.initializing = (async () => {
        const result = await this.request(state, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: SERVER_NAME, version: VERSION } }, operation.signal);
        if (!result || typeof result.protocolVersion !== 'string') throw new SafeError(`${state.provider} remote MCP initialization has invalid format.`);
        state.protocol = result.protocolVersion;
        await this.request(state, 'notifications/initialized', undefined, operation.signal, true);
        state.initialized = true;
      })().finally(() => { operation.finish(); state.initializing = undefined; });
    }
    return waitFor(state.initializing, callerSignal);
  }

  async call(params, parentSignal) {
    const provider = this.routes.get(params?.name);
    if (!provider) throw new SafeError('Invalid Research Tools tool name.');
    const config = readConfig(this.file, this.provider);
    const secrets = this.providers.filter(name => PROVIDERS.includes(name)).map(name => config[name].apiKey);
    if (LOCAL_PROVIDERS.includes(provider)) return this.callLocal(provider, params, secrets, parentSignal);
    const key = config[provider]?.apiKey || '';
    if (['exa', 'tavily'].includes(provider) && !key) throw new SafeError(`${provider} has no key configured; run node scripts/setup.cjs, set ${this.provider ? 'apiKey' : provider + '.apiKey'} in private global configuration, and retry.`);
    const state = this.state(provider, key);
    const operation = this.operation(parentSignal);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.initialize(state, operation.signal);
          let forwarded = params;
          // The new Exa remote requires objective; retain the original public call form for legacy calls that supply only query.
          if (provider === 'exa' && params.name === 'web_search_exa' && params.arguments?.objective === undefined && typeof params.arguments?.query === 'string') {
            forwarded = { ...params, arguments: { ...params.arguments, objective: params.arguments.query.slice(0, 4096) } };
          }
          const result = await this.request(state, 'tools/call', forwarded, operation.signal);
          if (!result || typeof result !== 'object' || !Array.isArray(result.content)) throw new SafeError(`${provider} remote tool result has invalid format.`);
          const output = { content: result.content };
          for (const field of ['structuredContent', 'isError']) if (Object.hasOwn(result, field)) output[field] = result[field];
          return redact(output, secrets);
        } catch (error) {
          if (error instanceof HttpError && attempt === 0 && [401, 403, 404].includes(error.status) && state.initialized) {
            state.initialized = false;
            state.session = undefined;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw operation.signal.aborted ? aborted() : new SafeError(`${provider} remote call failed.`);
    } finally { operation.finish(); }
  }

  async callLocal(provider, params, secrets, parentSignal) {
    let state = this.local.get(provider);
    if (!state) { state = { transport: this.createLocal(provider), initialized: false, initializing: undefined }; this.local.set(provider, state); }
    const operation = this.operation(parentSignal);
    try {
      if (!state.initialized) {
        if (!state.initializing) {
          const handshake = this.operation();
          state.initializing = (async () => {
            await state.transport.start(handshake.signal);
            const result = await state.transport.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: SERVER_NAME, version: VERSION } }, handshake.signal);
            if (!result || typeof result.protocolVersion !== 'string') throw new SafeError(`${provider} local MCP initialization has invalid format.`);
            state.protocol = result.protocolVersion;
            await state.transport.request('notifications/initialized', undefined, handshake.signal, true);
            state.initialized = true;
          })().catch(async error => { if (this.local.get(provider) === state) this.local.delete(provider); await state.transport.close(); throw error; }).finally(() => { handshake.finish(); state.initializing = undefined; });
        }
        await waitFor(state.initializing, operation.signal);
      }
      const result = await state.transport.request('tools/call', params, operation.signal);
      if (!result || typeof result !== 'object' || !Array.isArray(result.content)) throw new SafeError(`${provider} local tool result has invalid format.`);
      const output = { content: result.content };
      for (const field of ['structuredContent', 'isError']) if (Object.hasOwn(result, field)) output[field] = result[field];
      return redact(output, secrets);
    } catch (error) {
      if (!operation.signal.aborted) {
        if (this.local.get(provider) === state) this.local.delete(provider);
        await state.transport.close();
      }
      if (error instanceof SafeError) throw error;
      throw operation.signal.aborted ? aborted() : new SafeError(`${provider} local call failed.`);
    } finally { operation.finish(); }
  }

  async dispatch(message, signal) {
    switch (message.method) {
      case 'initialize': return { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: VERSION } };
      case 'ping': return {};
      case 'tools/list': return { tools: this.tools };
      case 'tools/call':
        try { return await this.call(message.params, signal); }
        catch (error) { return { content: [{ type: 'text', text: error instanceof SafeError ? error.message : 'Research Tools call failed.' }], isError: true }; }
      default: throw new SafeError('Unsupported MCP method.');
    }
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.states.clear();
    this.closing = Promise.allSettled([...this.local.values()].map(state => state.transport.close()));
    this.local.clear();
    return this.closing;
  }
}

function runStdio(gateway, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const pending = new Map();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let stopped = false;
  const write = value => { if (!stopped) output.write(`${JSON.stringify(value)}\n`); };
  let closing;
  const close = () => { if (stopped) return closing; stopped = true; for (const controller of pending.values()) controller.abort(); pending.clear(); lines.close(); closing = Promise.resolve(gateway.close()).finally(() => options.onClose?.()); return closing; };
  lines.on('close', close);
  lines.on('line', line => {
    let message;
    try { if (line.length > 1024 * 1024) throw new Error(); message = JSON.parse(line); }
    catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC format.' } }); return; }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { write({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request.' } }); return; }
    if (message.method === 'notifications/cancelled') { pending.get(message.params?.requestId)?.abort(); return; }
    if (!Object.hasOwn(message, 'id')) return;
    if (pending.has(message.id)) { write({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Duplicate request ID.' } }); return; }
    const controller = new AbortController();
    pending.set(message.id, controller);
    gateway.dispatch(message, controller.signal).then(result => write({ jsonrpc: '2.0', id: message.id, result }), () => write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported MCP method.' } })).finally(() => pending.delete(message.id));
  });
  return { close, pending };
}

module.exports = { Gateway, runStdio, readRpc, redact, PROTOCOL, ENDPOINTS, REMOTE_PROVIDERS, LOCAL_PROVIDERS };
