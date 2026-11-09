'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const readline = require('node:readline');

const DISCOVERY_GRACE_MS = 1000;
const PAGE_GRACE_MS = 10000;
const STOP_GRACE_MS = 1500;
const INITIALIZE_TIMEOUT_MS = 60000;
const DISCOVERY_TIMEOUT_MS = 60000;
const MAX_CATALOG_PAGES = 128;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function catalogKey(snapshot, params) {
  return createHash('sha256').update(canonical([snapshot.fingerprint, params ?? null])).digest('hex');
}

function readCatalog(file, key) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached.key === key && validInitialize(cached.initialize) && validTools(cached.list)) return cached;
  } catch (_) {}
  return null;
}

function writeCatalog(file, catalog) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (_) {
    // The directory is optional. A read-only, busy or missing cache must still allow a real discovery.
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function validInitialize(result) {
  return result && typeof result.protocolVersion === 'string' && result.capabilities &&
    typeof result.serverInfo?.name === 'string' && typeof result.serverInfo?.version === 'string';
}

function validTools(result) {
  return result && Array.isArray(result.tools) && result.tools.every((tool) => typeof tool?.name === 'string');
}

function hasPrivateMetadata(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    ((typeof child === 'string' || typeof child === 'number') &&
      /(?:session[-_]?id|token|secret|password|authorization)$/i.test(key)) ||
    hasPrivateMetadata(child));
}

function canPersist(snapshot, initialize, list) {
  const knownInitializeFields = ['protocolVersion', 'capabilities', 'serverInfo', 'instructions'];
  if (Object.keys(initialize).some((key) => !knownInitializeFields.includes(key))) return false;
  if (Object.keys(list).some((key) => key !== 'tools')) return false;
  if (snapshot.statusTool && list.tools.every((tool) => tool.name === snapshot.statusTool)) return false;
  if (hasPrivateMetadata(initialize) || hasPrivateMetadata(list)) return false;
  const serialized = JSON.stringify([initialize, list]);
  return !(snapshot.secrets || []).some((secret) => secret && serialized.includes(JSON.stringify(secret).slice(1, -1)));
}

class RpcError extends Error {
  constructor(rpc) {
    super(rpc.message);
    this.rpc = rpc;
  }
}

function localError(message, code = -32603) {
  return new RpcError({ code, message });
}

/** Own one MCP stdio session. Only discovery sessions may retire their Python backend. */
class LazyMcp {
  constructor(options) {
    this.options = options;
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.stderr = options.stderr || process.stderr;
    this.hostRequests = new Map();
    this.prefix = 'dbg-' + randomUUID();
    this.sequence = 0;
    this.active = false;
    this.closed = false;
    this.finished = new Promise((resolve) => { this.finish = resolve; });
  }

  start() {
    this.lines = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    this.lines.on('line', (line) => this.onHostLine(line));
    this.lines.once('close', () => this.close());
    this.transportError = () => this.close();
    this.input.on('error', this.transportError);
    this.output.on('error', this.transportError);
    this.signal = () => this.close();
    if (this.options.watchProcess !== false) {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, this.signal);
      const parent = process.ppid;
      const ownerAlive = this.options.ownerAlive || (() => {
        if (parent < 2 || process.ppid !== parent) return false;
        try { process.kill(parent, 0); return true; } catch (error) { return error.code === 'EPERM'; }
      });
      this.ownerTimer = setInterval(() => { if (!ownerAlive()) this.close(); }, this.options.ownerCheckMs ?? 1000);
      this.ownerTimer.unref();
    }
    return this;
  }

  id(direction) {
    return this.prefix + ':' + direction + ':' + ++this.sequence;
  }

  send(message) {
    if (!this.closed) this.output.write(JSON.stringify(message) + '\n');
  }

  onHostLine(line) {
    let message;
    try { message = JSON.parse(line); } catch (_) {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
      return;
    }
    if (typeof message.method === 'string' && own(message, 'id')) {
      if (this.hostRequests.has(message.id)) {
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Duplicate request ID' } });
        return;
      }
      const request = { id: message.id };
      this.hostRequests.set(request.id, request);
      clearTimeout(this.discoveryTimer);
      this.request(message, request).then(
        (response) => { if (!request.cancelled) this.send({ ...response, id: request.id }); },
        (error) => {
          if (!request.cancelled) this.send({ jsonrpc: '2.0', id: request.id,
            error: error.rpc || { code: -32603, message: 'Dbg MCP request failed' } });
        },
      ).finally(() => {
        if (this.hostRequests.get(request.id) === request) this.hostRequests.delete(request.id);
        this.scheduleRetirement();
      });
    } else {
      this.routeHostMessage(message);
    }
  }

  async request(message, request) {
    if (message.method === 'initialize') {
      if (this.initializeMessage) throw localError('Dbg MCP was already initialized', -32600);
      this.initializeMessage = message;
      const snapshot = this.options.snapshot();
      this.catalog = snapshot.cacheable ? readCatalog(this.options.cacheFile, catalogKey(snapshot, message.params)) : null;
      if (this.catalog) {
        this.initializeResult = this.catalog.initialize;
        this.observedFingerprint = snapshot.fingerprint;
      }
      else await this.ensureBackend();
      return { jsonrpc: '2.0', result: this.initializeResult };
    }
    if (message.method === 'ping' && !this.backend?.ready) return { jsonrpc: '2.0', result: {} };
    if (!this.initializeMessage) throw localError('Dbg MCP must be initialized first', -32002);
    if (message.method === 'tools/list' && !this.active) {
      if (message.params == null || Object.keys(message.params).length === 0) {
        const snapshot = this.options.snapshot();
        if (this.catalog && snapshot.cacheable && this.catalog.key === catalogKey(snapshot, this.initializeMessage.params)) {
          return { jsonrpc: '2.0', result: this.catalog.list };
        }
        const context = await this.ensureBackend();
        if (request.cancelled) return {};
        return this.sharedDiscovery(context, message, request);
      }
    } else if (message.method !== 'ping') {
      this.active = true;
    }
    const context = await this.ensureBackend();
    if (request.cancelled) return {};
    const timeout = message.method === 'tools/list' && !this.active ? this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS : undefined;
    const response = await this.rpc(context, message, request, timeout);
    if (message.method === 'tools/list') this.trackCursor(context, response, message.params?.cursor);
    return response;
  }

  async sharedDiscovery(context, message, request) {
    let discovery = context.discovery;
    if (!discovery || discovery.controller.signal.aborted) {
      discovery = { consumers: new Set(), controller: new AbortController() };
      context.discovery = discovery;
      discovery.promise = this.discover(context, message, discovery.controller.signal).finally(() => {
        if (context.discovery === discovery) context.discovery = null;
      });
    }
    request.discovery = discovery;
    discovery.consumers.add(request);
    try { return await discovery.promise; }
    finally {
      discovery.consumers.delete(request);
      request.discovery = null;
    }
  }

  async discover(context, message, signal) {
    const deadline = Date.now() + (this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS);
    const first = await this.rpc(context, message, undefined, deadline - Date.now(), signal);
    if (first.error || !validTools(first.result)) return first;
    const preserveFirstPage = () => {
      this.trackCursor(context, first);
      return first;
    };
    const tools = [...first.result.tools];
    let page = first.result;
    const visited = new Set();
    while (page.nextCursor != null) {
      if (typeof page.nextCursor !== 'string' || visited.has(page.nextCursor) ||
          visited.size >= MAX_CATALOG_PAGES || Object.keys(page).some((key) => key !== 'tools' && key !== 'nextCursor')) {
        return preserveFirstPage();
      }
      visited.add(page.nextCursor);
      if (Date.now() >= deadline) return preserveFirstPage();
      const next = await this.rpc(context, { ...message, params: { cursor: page.nextCursor } }, undefined, deadline - Date.now(), signal);
      if (next.error || !validTools(next.result)) return preserveFirstPage();
      page = next.result;
      tools.push(...page.tools);
    }
    if (Object.keys(page).some((key) => key !== 'tools' && key !== 'nextCursor')) return preserveFirstPage();
    const list = { tools };
    const snapshot = this.options.snapshot();
    if (context.snapshot.cacheable && snapshot.cacheable && snapshot.fingerprint === context.snapshot.fingerprint &&
        !context.catalogChanged && canPersist(snapshot, this.initializeResult, list)) {
      this.catalog = { key: catalogKey(snapshot, this.initializeMessage.params), initialize: this.initializeResult, list };
      writeCatalog(this.options.cacheFile, this.catalog);
    }
    // No backend cursor leaves this flattened response or survives in the on-disk cache.
    return visited.size ? { ...first, result: list } : first;
  }

  trackCursor(context, response, requestedCursor) {
    if (response.error) return;
    context.cursors.delete(requestedCursor);
    const next = response.result?.nextCursor;
    if (typeof next === 'string') context.cursors.add(next);
  }

  routeHostMessage(message) {
    const context = this.backend;
    if (message.method === 'notifications/initialized') {
      this.initializedMessage = message;
      if (context?.ready) this.sendInitialized(context);
    } else if (message.method === 'notifications/cancelled') {
      const request = this.hostRequests.get(message.params?.requestId);
      if (!request) return;
      request.cancelled = true;
      this.hostRequests.delete(request.id);
      if (request.discovery) {
        const discovery = request.discovery;
        discovery.consumers.delete(request);
        if (!discovery.consumers.size) discovery.controller.abort(message);
      } else if (request.forwardedId && context?.pending.has(request.forwardedId)) {
        context.pending.get(request.forwardedId).resolve({});
        context.pending.delete(request.forwardedId);
        this.sendBackend(context, { ...message, params: { ...message.params, requestId: request.forwardedId } });
      }
    } else if (message.method) {
      if (!this.initializeMessage) return;
      clearTimeout(this.discoveryTimer);
      this.active = true;
      this.ensureBackend().then((target) => this.sendBackend(target, message)).catch(() => {});
    } else if (context && context.callbacks.has(message.id)) {
      const id = context.callbacks.get(message.id);
      context.callbacks.delete(message.id);
      this.sendBackend(context, { ...message, id });
      this.scheduleRetirement();
    }
  }

  onBackendLine(context, line) {
    if (context.stopping || context.failed || this.closed) return;
    let message;
    try { message = JSON.parse(line); } catch (_) {
      this.failBackend(context, localError('Invalid JSON from Dbg MCP backend'));
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.failBackend(context, localError('Invalid response from Dbg MCP backend'));
      return;
    }
    if (message.method) {
      if (own(message, 'id')) {
        clearTimeout(this.discoveryTimer);
        const id = this.id('backend');
        context.callbacks.set(id, message.id);
        this.send({ ...message, id });
      } else if (message.method === 'notifications/cancelled') {
        for (const [id, original] of context.callbacks) {
          if (original !== message.params?.requestId) continue;
          context.callbacks.delete(id);
          this.send({ ...message, params: { ...message.params, requestId: id } });
          break;
        }
        this.scheduleRetirement();
      } else {
        if (message.method === 'notifications/tools/list_changed') {
          context.catalogChanged = true;
          this.catalog = null;
          const snapshot = this.options.snapshot();
          if (snapshot.cacheable) {
            const file = this.options.cacheFile;
            const key = catalogKey(snapshot, this.initializeMessage.params);
            try { if (readCatalog(file, key)) fs.unlinkSync(file); } catch (_) {}
          }
        }
        this.send(message);
      }
      return;
    }
    const pending = context.pending.get(message.id);
    if (!pending) return;
    context.pending.delete(message.id);
    pending.resolve(message);
  }

  async rpc(context, message, request, timeoutMs, signal) {
    if (context.failed || context.stopping || this.closed) throw localError('Dbg MCP backend is disconnected');
    if (signal?.aborted) throw localError('Dbg MCP discovery was cancelled', -32800);
    const id = this.id(message.method === 'initialize' ? 'initialize' : 'host');
    if (request) request.forwardedId = id;
    let timeout, onAbort;
    try {
      return await new Promise((resolve, reject) => {
        context.pending.set(id, { resolve, reject });
        if (signal) {
          onAbort = () => {
            if (!context.pending.delete(id)) return;
            const cancellation = signal.reason;
            reject(localError('Dbg MCP discovery was cancelled', -32800));
            this.sendBackend(context, { ...cancellation, params: { ...cancellation.params, requestId: id } });
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
        if (timeoutMs !== undefined) {
          timeout = setTimeout(() => {
            context.pending.delete(id);
            reject(localError('Dbg MCP backend timed out for ' + message.method));
            if (message.method !== 'initialize') this.sendBackend(context, {
              jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id },
            });
          }, timeoutMs);
        }
        this.sendBackend(context, { ...message, id });
      });
    } finally {
      clearTimeout(timeout);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  sendBackend(context, message) {
    if (!context.failed && !context.stopping && !this.closed) context.child.stdin.write(JSON.stringify(message) + '\n');
  }

  sendInitialized(context) {
    if (!context.initialized && this.initializedMessage) {
      context.initialized = true;
      this.sendBackend(context, this.initializedMessage);
    }
  }

  ensureBackend() {
    if (this.closed) return Promise.reject(localError('Dbg MCP session is closed'));
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.starting) return this.starting;
    if (this.backend?.ready && !this.backend.failed && !this.backend.stopping) return Promise.resolve(this.backend);
    this.starting = this.startBackend().catch((error) => {
      if (this.active) this.terminalError = error;
      throw error;
    }).finally(() => { this.starting = null; this.scheduleRetirement(); });
    return this.starting;
  }

  async startBackend() {
    if (this.backend) await this.stopBackend(this.backend);
    if (this.closed) throw localError('Dbg MCP session is closed');
    if (this.terminalError) throw this.terminalError;
    let child;
    try {
      if (this.options.prepare) {
        const controller = new AbortController();
        this.preparing = controller;
        try { await this.options.prepare(controller.signal); } finally { this.preparing = null; }
      }
      if (this.closed) throw localError('Dbg MCP session is closed');
      child = this.options.launch();
    } catch (error) {
      if (error.code === 'DBG_NEEDS_DOCTOR') throw new RpcError({
        code: -32004, message: 'Dbg needs Python 3.11 or newer. Prepare the runtime with Dbg doctor.',
        data: { reason: 'needs_doctor' },
      });
      if (error.rpc) throw error;
      throw localError('Dbg MCP runtime could not be prepared');
    }
    const context = { child, snapshot: this.options.snapshot(), pending: new Map(), callbacks: new Map(), cursors: new Set() };
    this.backend = context;
    context.closed = new Promise((resolve) => child.once('close', () => { context.exited = true; resolve(true); }));
    const failed = () => this.failBackend(context, localError('Dbg MCP backend disconnected. Reload the MCP session to reconnect.'));
    child.on('error', failed);
    child.on('close', failed);
    child.stdin.on('error', failed);
    child.stdout.on('error', failed);
    context.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    context.lines.on('line', (line) => this.onBackendLine(context, line));
    context.lines.once('close', failed);
    if (child.stderr) {
      child.stderr.on('data', (chunk) => { if (!this.closed) this.stderr.write(chunk); });
      child.stderr.on('error', failed);
    }
    try {
      const response = await this.rpc(context, this.initializeMessage, undefined, this.options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS);
      if (response.error) throw new RpcError(response.error);
      if (!validInitialize(response.result)) throw localError('Dbg MCP backend returned an invalid initialize result');
      if (this.initializeResult && canonical(response.result) !== canonical(this.initializeResult)) {
        throw localError('Dbg MCP backend initialize contract changed. Reload the MCP session before using this debugger.');
      }
      if (this.observedFingerprint && context.snapshot.fingerprint !== this.observedFingerprint) {
        throw localError('Dbg MCP backend deployment changed. Reload the MCP session before using this debugger.');
      }
      if (this.closed || context.failed || context.stopping) throw localError('Dbg MCP backend disconnected during initialization');
      this.initializeResult = response.result;
      this.observedFingerprint = context.snapshot.fingerprint;
      this.sendInitialized(context);
      context.ready = true;
      return context;
    } catch (error) {
      await this.stopBackend(context);
      throw error;
    }
  }

  failBackend(context, error) {
    if (context.stopping || context.failed) return;
    context.failed = true;
    if (this.active) this.terminalError = error;
    for (const pending of context.pending.values()) pending.reject(error);
    context.pending.clear();
    context.callbacks.clear();
    this.stopBackend(context);
  }

  scheduleRetirement() {
    clearTimeout(this.discoveryTimer);
    const context = this.backend;
    if (this.options.keepAlive || this.active || this.closed || this.starting || this.hostRequests.size || !context?.ready ||
        context.stopping || context.pending.size || context.callbacks.size) return;
    const grace = context.cursors.size ? this.options.pageGraceMs ?? PAGE_GRACE_MS : this.options.discoveryGraceMs ?? DISCOVERY_GRACE_MS;
    this.discoveryTimer = setTimeout(() => this.stopBackend(context), grace);
    this.discoveryTimer.unref();
  }

  stopBackend(context) {
    if (context.stopping) return context.stopping;
    // Publish retirement before ending stdin. A request arriving during shutdown must wait for this child.
    context.stopping = Promise.resolve().then(async () => {
      for (const pending of context.pending.values()) pending.reject(localError('Dbg MCP backend is shutting down'));
      context.pending.clear();
      context.callbacks.clear();
      context.lines.close();
      context.child.stdin.end();
      if (!await this.waitForClose(context)) {
        const child = context.child;
        // ChildProcess uses the owned process handle. The Python owner is responsible for its own descendants.
        if (child.exitCode === null && child.signalCode === null) child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
        let stopped = await this.waitForClose(context);
        if (!stopped && process.platform !== 'win32' && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          stopped = await this.waitForClose(context);
        }
        if (!stopped) {
          this.terminalError = localError('Dbg MCP could not confirm backend shutdown');
          child.stdout.destroy();
          child.stderr?.destroy();
          child.stdin.destroy();
          child.unref();
        }
      }
      if (this.backend === context) this.backend = null;
    });
    return context.stopping;
  }

  async waitForClose(context) {
    if (context.exited) return true;
    let timeout;
    try {
      return await Promise.race([context.closed, new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), this.options.stopGraceMs ?? STOP_GRACE_MS);
      })]);
    } finally { clearTimeout(timeout); }
  }

  close() {
    if (this.closed) return this.finished;
    this.closed = true;
    clearInterval(this.ownerTimer);
    clearTimeout(this.discoveryTimer);
    this.lines.close();
    this.input.pause();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, this.signal);
    this.preparing?.abort();
    const cleanup = this.backend ? this.stopBackend(this.backend) : this.starting;
    Promise.resolve(cleanup).catch(() => {}).then(this.finish);
    return this.finished;
  }
}

module.exports = { LazyMcp };
