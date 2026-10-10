'use strict';

const readline = require('node:readline');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const STARTUP_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const LOGGING_LEVELS = new Set(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']);

// Windows console entry points可能另起python。按树结束，不能只kill launcher.exe。
async function killProcessTree(child) {
  // 只能结束仍存活的自有ChildProcess；退出后不能用旧PID去taskkill。
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    await new Promise((resolve, reject) => {
      let killer;
      try {
        killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', reject);
        killer.once('exit', (code) => code === 0 || child.exitCode != null || child.signalCode != null
          ? resolve() : reject(new Error(`CRG tree termination failed (${code})`)));
      } catch (error) { reject(error); }
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {
      if (child.exitCode != null || child.signalCode != null) return;
      if (!child.kill('SIGKILL')) throw new Error('CRG process termination failed');
    }
  }
}

/** 轻量stdio前端；发现用真实catalog，首次实际请求才连接原始CRG服务。 */
class LazyMcpProxy {
  constructor(options) {
    this.options = options;
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.stderr = options.stderr || process.stderr;
    this.catalogPromise = null;
    this.child = null;
    this.starting = null;
    this.closed = false;
    this.ready = false;
    this.state = 'cold';
    this.backend = null;
    this.retiring = null;
    this.clock = options.clock || { now: () => performance.now(), setTimeout, clearTimeout };
    this.idleTimeoutMs = options.idleTimeoutMs === undefined ? DEFAULT_IDLE_TIMEOUT_MS : options.idleTimeoutMs;
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) throw new Error('Invalid CRG idle timeout');
    this.idleTimer = null;
    this.sequence = 0;
    // 两个方向用独立命名空间，不与宿主数字/string ID或后端callback ID共享。
    this.prefix = `crg-${crypto.randomUUID()}`;
    this.pending = new Map();
    this.hostRequests = new Map();
    this.callbacks = new Map();
    this.progressTokens = new Map();
    this.notifications = [];
    this.abortController = new AbortController();
    this.initializeParams = null;
    this.loggingLevel = undefined;
  }

  nextId(direction) { return `${this.prefix}:${direction}:${++this.sequence}`; }
  clearIdle() {
    if (this.idleTimer !== null) this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
  busy() { return !!this.starting || this.pending.size > 0 || this.callbacks.size > 0; }
  completedWork() {
    this.clearIdle();
    if (this.closed || !this.ready || !this.backend || this.busy()) return;
    this.lastWorkCompleted = this.clock.now();
    const context = this.backend;
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null;
      if (this.closed || this.backend !== context || !this.ready || this.busy()) return;
      this.disposeBackend(context, 'idle').catch(() => {});
    }, this.idleTimeoutMs);
    if (this.idleTimer && this.idleTimer.unref) this.idleTimer.unref();
  }

  async stopOwnedBackend(context) {
    if (context.exited) return;
    if (context.stopping) return context.stopping;
    context.stopping = (async () => {
      try { await (this.options.killTree || killProcessTree)(context.child); }
      catch (error) { if (!context.exited) throw error; }
      // taskkill成功与ChildProcess退出可能相隔一轮事件；新后端必须等到退出确认。
      await context.exitPromise;
    })();
    try { await context.stopping; } finally { context.stopping = null; }
  }

  assertBackendAvailable(context) {
    if (this.closed || this.backend !== context || context.failed || context.exited) throw new Error('CRG backend unavailable during state replay');
  }

  /** 新启动和停止失败后的原后端，都在同一同步边界完成重放并发布 ready。 */
  async replayBackendState(context) {
    let appliedLevel;
    while (this.loggingLevel !== appliedLevel) {
      this.assertBackendAvailable(context);
      const level = this.loggingLevel;
      const id = this.nextId('logging');
      await new Promise((resolve, reject) => {
        this.pending.set(id, { internal: true, resolve, reject });
        this.toBackend({ id, method: 'logging/setLevel', params: { level } });
      });
      appliedLevel = level;
    }
    this.assertBackendAvailable(context);
    for (const notification of this.notifications.splice(0)) this.toBackend(notification);
    // flush 可能同步触发 stream error；失败不能被 ready 覆盖。
    // 最后的状态核对、通知 flush 与 ready 发布之间不能再 await/return 给外层，
    // 否则宿主在 cached catalog await 后确认的新日志级别可能只写入冷缓存。
    this.assertBackendAvailable(context);
    this.ready = true;
    this.state = 'ready';
  }

  disposeBackend(context, reason) {
    if (this.retiring) return this.retiring;
    this.clearIdle();
    this.ready = false;
    this.state = 'retiring';
    context.retiring = true;
    if (reason === 'idle') this.stderr.write(`[codemap-boost-codex] CRG idle retiring pid=${context.child.pid || 'unknown'}\n`);
    this.retiring = (async () => {
      await this.stopOwnedBackend(context);
      context.lines.close();
      if (this.backend === context) { this.backend = null; this.child = null; this.state = 'cold'; }
      if (reason === 'idle') this.stderr.write(`[codemap-boost-codex] CRG idle stopped pid=${context.child.pid || 'unknown'}\n`);
    })().catch(async (error) => {
      this.stderr.write(`[codemap-boost-codex] CRG ${reason} termination failed pid=${context.child.pid || 'unknown'}: ${error.message}\n`);
      if (this.backend === context) {
        context.retiring = false;
        this.ready = false;
        this.state = 'failed';
        if (!context.failed && !context.exited && !this.closed) {
          this.state = 'recovering';
          try {
            await this.replayBackendState(context);
            this.assertBackendAvailable(context);
            return;
          } catch (replayError) {
            context.failed = true;
            this.state = 'failed';
            this.backendFailed(replayError);
            if (!this.closed) this.stderr.write(`[codemap-boost-codex] CRG retained backend state replay failed pid=${context.child.pid || 'unknown'}: ${replayError.message}\n`);
            throw replayError;
          }
        }
      }
      throw error;
    }).finally(() => { this.retiring = null; if (this.ready) this.completedWork(); });
    // 事件处理器可发起清理；等待者仍收到原始失败，避免unhandled rejection。
    this.retiring.catch(() => {});
    return this.retiring;
  }
  send(message) { if (!this.closed) this.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
  toBackend(message) {
    if (this.child && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }
  catalog() {
    if (!this.catalogPromise) {
      this.catalogPromise = Promise.resolve().then(() => this.options.catalog(this.abortController.signal));
      this.catalogPromise.catch(() => { this.catalogPromise = null; });
    }
    return this.catalogPromise;
  }

  run() {
    return new Promise((resolve) => {
      this.resolveExit = resolve;
      this.lines = readline.createInterface({ input: this.input, crlfDelay: Infinity });
      this.lines.on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch (_) { this.send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
        this.handleHost(message).catch((error) => this.stderr.write(`[codemap-boost-codex] MCP: ${error.message}\n`));
      });
      this.lines.once('close', () => this.close(0));
      this.input.once('error', () => this.close(1));
      this.output.once('error', () => this.close(1));
      this.signals = {};
      for (const signal of ['SIGINT', 'SIGTERM']) {
        this.signals[signal] = () => this.close(0);
        process.once(signal, this.signals[signal]);
      }
    });
  }

  async handleHost(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message !== 'object' || Array.isArray(message)) {
      this.send({ id: null, error: { code: -32600, message: 'Invalid Request' } }); return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    if (!message.method) {
      const callback = this.callbacks.get(message.id);
      if (callback && callback.context === this.backend) {
        this.callbacks.delete(message.id); this.toBackend({ ...message, id: callback.id });
        this.completedWork();
      }
      return;
    }
    if (!hasId) {
      if (message.method === 'notifications/initialized') return;
      if (message.method === 'notifications/cancelled') {
        const record = this.hostRequests.get(message.params && message.params.requestId);
        if (!record || record.method === 'initialize') return;
        record.cancelled = true; clearInterval(record.progressTimer);
        this.hostRequests.delete(record.id);
        if (record.backendId) {
          // 取消只是通知；后端仍可能执行，直到响应或退出才能释放占用。
          this.progressTokens.delete(record.backendToken);
          this.toBackend({ ...message, params: { ...message.params, requestId: record.backendId } });
        }
        return;
      }
      if (this.ready) { this.clearIdle(); this.toBackend(message); this.completedWork(); }
      else this.notifications.push(message);
      return;
    }
    if (this.hostRequests.has(message.id)) {
      this.send({ id: message.id, error: { code: -32600, message: 'Duplicate in-flight request ID' } }); return;
    }
    const record = { id: message.id, method: message.method, cancelled: false };
    this.hostRequests.set(record.id, record);
    try {
      if (message.method === 'ping') return this.reply(record, {});
      if (message.method === 'initialize') {
        this.initializeParams = message.params;
        const c = await this.catalog();
        const requested = message.params && message.params.protocolVersion;
        const protocolVersion = (c.supportedProtocolVersions || [c.protocolVersion]).includes(requested) ? requested : c.protocolVersion;
        this.negotiatedProtocol = protocolVersion;
        return this.reply(record, { protocolVersion, capabilities: c.capabilities, serverInfo: c.serverInfo, ...(c.instructions ? { instructions: c.instructions } : {}) });
      }
      const discovery = { 'tools/list': 'tools', 'prompts/list': 'prompts', 'resources/list': 'resources', 'resources/templates/list': 'resourceTemplates' };
      if (discovery[message.method]) {
        if (message.params && message.params.cursor) throw new Error('Invalid discovery cursor');
        const c = await this.catalog();
        return this.reply(record, { [discovery[message.method]]: c[discovery[message.method]] });
      }
      const c = await this.catalog();
      if (!Array.isArray(c.requestMethods) || !c.requestMethods.includes(message.method)) {
        return this.reply(record, undefined, { code: -32601, message: `Method not found: ${message.method}` });
      }
      if (message.method === 'logging/setLevel') {
        const level = message.params && message.params.level;
        if (!LOGGING_LEVELS.has(level)) {
          return this.reply(record, undefined, { code: -32602, message: 'Invalid logging level' });
        }
        this.loggingLevel = level;
        // 日志级别是客户端配置；冷状态记录即可，不能为配置启动模型后端。
        if (!this.ready) return this.reply(record, {});
      }
      const token = message.params && message.params._meta && message.params._meta.progressToken;
      if (token !== undefined && !this.ready) {
        record.coldProgress = 0;
        const notify = () => this.send({ method: 'notifications/progress', params: { progressToken: token, progress: ++record.coldProgress, message: '正在准备并启动 CRG 运行时（保留 Windows 模型预热）' } });
        notify(); record.progressTimer = setInterval(notify, this.options.progressIntervalMs || 5000);
      }
      await this.ensureBackend();
      clearInterval(record.progressTimer);
      if (record.cancelled || this.closed) return;
      if (!this.ready || !this.child) throw new Error('CRG backend disconnected before request forwarding');
      this.clearIdle();
      record.backendId = this.nextId('host');
      this.pending.set(record.backendId, record);
      let forwarded = { ...message, id: record.backendId };
      if (token !== undefined) {
        record.backendToken = this.nextId('progress');
        record.hostToken = token;
        this.progressTokens.set(record.backendToken, record);
        forwarded = { ...forwarded, params: { ...message.params, _meta: { ...message.params._meta, progressToken: record.backendToken } } };
      }
      this.toBackend(forwarded);
    } catch (error) {
      clearInterval(record.progressTimer);
      if (!record.cancelled) this.reply(record, undefined, { code: -32603, message: error.message });
    }
  }

  reply(record, result, error) {
    if (this.hostRequests.get(record.id) === record) this.hostRequests.delete(record.id);
    clearInterval(record.progressTimer);
    this.progressTokens.delete(record.backendToken);
    if (!record.cancelled) this.send({ id: record.id, ...(error ? { error } : { result }) });
  }

  async ensureBackend() {
    if (this.retiring) await this.retiring;
    if (this.closed) throw new Error('MCP connection closed');
    if (this.ready) return;
    if (this.starting) return this.starting;
    if (this.backend) await this.disposeBackend(this.backend, 'retry');
    if (this.closed) throw new Error('MCP connection closed');
    // 清理等待期间可能有另一个请求先开始启动。
    if (this.starting) return this.starting;
    this.clearIdle();
    this.state = 'starting';
    const controller = new AbortController();
    this.startController = controller;
    let timeout, launch;
    this.starting = (async () => {
      const c = await this.catalog();
      launch = (async () => {
        const child = await this.options.launchBackend(controller.signal);
        const context = { child, exited: false, failed: false, retiring: false };
        context.exitPromise = new Promise((resolve) => { context.resolveExit = resolve; });
        this.backend = context;
        this.child = child;
        const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        this.backendLines = lines;
        lines.on('line', (line) => {
          if (this.backend !== context || context.retiring) return;
          try { this.handleBackend(JSON.parse(line)); } catch (error) { failed(new Error(`Invalid backend JSON: ${error.message}`)); }
        });
        context.lines = lines;
        child.stderr.on('data', (chunk) => this.stderr.write(chunk));
        const failed = (error) => {
          if (this.backend !== context) return;
          context.failed = true;
          if (context.retiring) return;
          this.clearIdle();
          this.backendFailed(error);
          if (!this.starting) this.disposeBackend(context, 'failure').catch(() => {});
        };
        child.once('error', (error) => {
          if (!Number.isInteger(child.pid)) { context.exited = true; context.resolveExit(); }
          failed(error);
        });
        child.once('exit', (code) => {
          context.exited = true; context.resolveExit();
          failed(new Error(`CRG backend exited (${code})`));
        });
        child.stdin.on('error', failed);
        child.stdout.on('error', failed);
        child.stderr.on('error', failed);
        if (controller.signal.aborted || this.closed) throw new Error('MCP startup cancelled');
        const id = this.nextId('initialize');
        const result = await new Promise((resolve, reject) => {
          this.pending.set(id, { internal: true, resolve, reject });
          this.toBackend({ id, method: 'initialize', params: this.initializeParams || { protocolVersion: c.protocolVersion, capabilities: {}, clientInfo: { name: 'codemap-boost-codex', version: '1' } } });
        });
        if (this.negotiatedProtocol && result.protocolVersion !== this.negotiatedProtocol) throw new Error('CRG backend protocol version differs from discovery catalog');
        this.toBackend({ method: 'notifications/initialized' });
        // 配置可能在启动期间更新；握手后用真实请求应用最后的值，重试时同样重放。
        await this.replayBackendState(context);
        this.assertBackendAvailable(context);
      })();
      await Promise.race([launch, new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('CRG startup cancelled')), { once: true });
        timeout = setTimeout(() => { reject(new Error('CRG cold startup timeout')); controller.abort(); }, this.options.startupTimeoutMs || STARTUP_TIMEOUT_MS);
      })]);
    })().catch(async (error) => {
      controller.abort();
      this.ready = false;
      this.backendFailed(error);
      // prepare尚未交还child时，超时/取消不能证明它停止。保留starting，
      // 等原launch确认退出或交还child，再清理；不并行启动第二份重型运行时。
      if (!this.backend && launch) await launch.catch(() => {});
      if (this.backend) { this.backend.failed = true; await this.disposeBackend(this.backend, 'startup'); }
      else this.state = 'cold';
      throw error;
    }).finally(() => { clearTimeout(timeout); this.starting = null; this.startController = null; this.completedWork(); });
    return this.starting;
  }

  handleBackend(message) {
    if (message.method) {
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        this.clearIdle();
        const id = this.nextId('backend'); this.callbacks.set(id, { id: message.id, context: this.backend });
        this.send({ ...message, id });
      } else if (message.method === 'notifications/progress') {
        const record = this.progressTokens.get(message.params && message.params.progressToken);
        if (record) {
          const offset = record.coldProgress ? record.coldProgress + 1 : 0;
          this.send({ ...message, params: { ...message.params, progressToken: record.hostToken,
            progress: message.params.progress + offset,
            ...(message.params.total !== undefined ? { total: message.params.total + offset } : {}),
          } });
        } else if (!(typeof message.params.progressToken === 'string' && message.params.progressToken.startsWith(`${this.prefix}:progress:`))) this.send(message);
      } else if (message.method === 'notifications/cancelled') {
        const callback = [...this.callbacks].find(([, record]) => record.id === (message.params && message.params.requestId));
        if (callback) { this.callbacks.delete(callback[0]); this.send({ ...message, params: { ...message.params, requestId: callback[0] } }); this.completedWork(); }
      } else this.send(message);
      return;
    }
    const record = this.pending.get(message.id);
    if (!record) return;
    this.pending.delete(message.id);
    if (record.internal) {
      if (message.error) record.reject(new Error(message.error.message)); else record.resolve(message.result);
    } else this.reply(record, message.result, message.error);
    this.completedWork();
  }

  backendFailed(error) {
    this.ready = false;
    for (const record of this.pending.values()) {
      if (record.internal) record.reject(error); else this.reply(record, undefined, { code: -32603, message: error.message });
    }
    this.pending.clear(); this.callbacks.clear(); this.progressTokens.clear();
  }

  async close(code) {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    this.abortController.abort();
    if (this.startController) this.startController.abort();
    for (const record of this.hostRequests.values()) clearInterval(record.progressTimer);
    this.backendFailed(new Error('MCP connection closed'));
    if (this.lines) this.lines.close();
    for (const [signal, handler] of Object.entries(this.signals || {})) process.removeListener(signal, handler);
    const context = this.backend;
    if (context) {
      try { context.child.stdin.end(); } catch (_) {}
      try {
        // EOF取消恢复中的内部RPC后，仍需重试结束原child，不能因前次停止失败跳过清理。
        if (this.retiring) await this.retiring.catch(() => {});
        if (this.backend === context) await this.disposeBackend(context, 'close');
      } catch (error) { this.stderr.write(`[codemap-boost-codex] MCP close: ${error.message}\n`); code = 1; }
    }
    if (this.resolveExit) this.resolveExit(code);
  }
}

module.exports = { LazyMcpProxy, STARTUP_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, IDLE_TIMEOUT_MS: DEFAULT_IDLE_TIMEOUT_MS, killProcessTree };
