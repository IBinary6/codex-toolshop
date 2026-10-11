'use strict';

const readline = require('node:readline');
const crypto = require('node:crypto');
const { killProcessTree } = require('./lazy-mcp.cjs');

const SEMANTIC_TOOLS = new Set(['find_symbol', 'get_symbols_overview', 'find_referencing_symbols',
  'find_declaration', 'find_implementations', 'get_diagnostics_for_file', 'rename_symbol',
  'replace_symbol_body', 'insert_before_symbol', 'insert_after_symbol', 'safe_delete_symbol']);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const successful = (response) => !!response && !response.error && response.result && !response.result.isError;
const resultText = (response) => ((response.result && response.result.content) || [])
  .filter((item) => item.type === 'text').map((item) => item.text).join('\n');
const diagnosticText = (item) => typeof item === 'string' ? item
  : item && typeof item === 'object' ? [item.code, item.message].filter(Boolean).join(': ') : String(item);
const isNonCpp = (project) => Array.isArray(project?.languages) && project.languages.length > 0 && !project.languages.includes('cpp');

/** Transparent native Serena connection; prepare projects only at tools/call boundaries without caching the tool catalog. */
class SerenaMcpProxy {
  constructor(options) {
    this.options = options;
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.stderr = options.stderr || process.stderr;
    this.prefix = `serena-${crypto.randomUUID()}`;
    this.sequence = 0;
    this.pending = new Map();
    this.requests = new Map();
    this.callbacks = new Map();
    this.progress = new Map();
    this.toolQueue = Promise.resolve();
    this.waiters = [];
    this.backend = null;
    this.starting = null;
    this.restarting = null;
    this.closed = false;
    this.active = null;
    this.activeContext = null;
    this.generation = null;
    this.preparedProject = null;
    this.modes = null;
  }

  id(kind) { return `${this.prefix}:${kind}:${++this.sequence}`; }
  send(message) { if (!this.closed) this.output.write(`${JSON.stringify(message)}\n`); }
  write(context, message) {
    if (!context || context !== this.backend || context.exited || context.failed || context.child.stdin.destroyed) {
      throw new Error('Serena backend unavailable');
    }
    context.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }
  changed() { for (const resolve of this.waiters.splice(0)) resolve(); }
  async drain() {
    if (this.closed) throw new Error('MCP connection closed');
    while (this.pending.size || this.callbacks.size) {
      if (this.closed) throw new Error('MCP connection closed');
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }

  async start(replay = true) {
    if (this.closed) throw new Error('MCP connection closed');
    if (this.starting) return this.starting;
    if (this.backend && !this.backend.failed && !this.backend.exited) return this.backend;
    // Stop backends with unconfirmed exit first; retain them on failure and prohibit duplicate startup.
    if (this.backend) await this.stop(this.backend);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const child = await this.options.launchBackend();
      const context = { child, exited: false, failed: false };
      context.exit = new Promise((resolve) => { context.resolveExit = resolve; });
      this.backend = context;
      context.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      const fail = (error) => {
        if (context !== this.backend) return;
        context.failed = true;
        for (const [id, record] of this.pending) {
          if (record.context === context) { clearTimeout(record.timer); this.pending.delete(id); record.reject(error); }
        }
        for (const [id, callback] of this.callbacks) if (callback.context === context) this.callbacks.delete(id);
        this.changed();
      };
      context.lines.on('line', (line) => {
        if (context !== this.backend) return;
        try { this.fromBackend(context, JSON.parse(line)); }
        catch (_) { fail(new Error('Invalid Serena backend JSON')); }
      });
      child.stderr.on('data', (chunk) => this.stderr.write(chunk));
      child.once('exit', (code) => {
        context.exited = true; context.resolveExit();
        fail(new Error(`Serena backend exited (${code})`));
      });
      child.once('error', (error) => {
        if (!Number.isInteger(child.pid)) { context.exited = true; context.resolveExit(); }
        fail(error);
      });
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', fail);
      if (this.closed) { await this.stop(context); throw new Error('MCP connection closed'); }
      if (replay && this.initializeParams) {
        try { await this.replayState(context, true); }
        catch (error) { context.failed = true; throw error; }
      }
      return context;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async stop(context, retryCleanup = false) {
    if (context.stopping) return context.stopping;
    if (context.cleanupError && !retryCleanup) throw context.cleanupError;
    context.stopping = (async () => {
      // Verify independent language services even after root exit; freeze generation on failure without automatically starting another backend.
      context.failed = true;
      if (this.options.stopBackend) await this.options.stopBackend(context);
      else if (!context.exited) await (this.options.killTree || killProcessTree)(context.child);
      // Successful termination commands do not prove child exit; timeout must not permit another backend.
      let timer;
      try {
        await Promise.race([context.exit, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Serena backend termination not confirmed')), this.options.stopTimeoutMs || 10000);
        })]);
      } finally { clearTimeout(timer); }
      context.lines.close();
      context.cleanupError = null;
      if (this.backend === context) this.backend = null;
    })().catch((error) => { context.cleanupError = error; throw error; })
      .finally(() => { context.stopping = null; });
    return context.stopping;
  }

  rpc(context, message, host) {
    const id = this.id('request');
    const forwarded = { ...message, id };
    if (host) {
      host.backendId = id;
      const token = message.params && message.params._meta && message.params._meta.progressToken;
      if (token !== undefined) {
        host.token = this.id('progress');
        this.progress.set(host.token, token);
        forwarded.params = { ...message.params, _meta: { ...message.params._meta, progressToken: host.token } };
      }
    }
    return new Promise((resolve, reject) => {
      const record = { context, host, resolve, reject };
      const timeout = this.options.requestTimeoutMs || 600000;
      record.timer = setTimeout(() => {
        // Retain pending state: request timeout proves neither backend shutdown nor permission to switch generations.
        reject(new Error('Serena backend request timeout'));
      }, timeout);
      if (record.timer.unref) record.timer.unref();
      this.pending.set(id, record);
      try { this.write(context, forwarded); } catch (error) {
        clearTimeout(record.timer); this.pending.delete(id); this.changed(); reject(error);
      }
    });
  }

  fromBackend(context, message) {
    if (message.method) {
      if (owns(message, 'id')) {
        const id = this.id('callback');
        this.callbacks.set(id, { id: message.id, context });
        this.send({ ...message, id });
      } else if (message.method === 'notifications/progress' && message.params) {
        const token = this.progress.get(message.params.progressToken);
        if (token !== undefined) this.send({ ...message, params: { ...message.params, progressToken: token } });
        else if (!String(message.params.progressToken).startsWith(this.prefix)) this.send(message);
      } else if (message.method === 'notifications/cancelled') {
        const found = [...this.callbacks].find(([, value]) => value.context === context && value.id === message.params?.requestId);
        if (found) {
          this.callbacks.delete(found[0]); this.changed();
          this.send({ ...message, params: { ...message.params, requestId: found[0] } });
        } else this.send(message);
      } else this.send(message);
      return;
    }
    const record = this.pending.get(message.id);
    if (!record || record.context !== context) return;
    this.pending.delete(message.id);
    clearTimeout(record.timer);
    if (record.host) this.progress.delete(record.host.token);
    record.resolve(message); this.changed();
  }

  async confirmActive(context, expected) {
    const response = await this.rpc(context, { method: 'tools/call', params: { name: 'get_current_config', arguments: {} } });
    await this.adoptActive(context, response, expected);
  }

  async adoptActive(context, response, expected) {
    this.active = null; this.activeContext = null;
    if (context !== this.backend || context.failed || context.exited || !successful(response)) return;
    const match = resultText(response).match(/^Active project: (.+)$/m);
    if (!match) return;
    // For duplicate names, require both the known target and native current name to prove root; never infer from cwd.
    let resolved = expected?.root && expected.name === match[1] ? expected : null;
    if (!resolved) {
      try { resolved = await this.options.resolveProject(match[1]); } catch (_) { return; }
    }
    if (context === this.backend && !context.failed && !context.exited && resolved?.root) {
      this.active = { ...resolved, name: match[1] }; this.activeContext = context;
    }
  }

  async replayState(context, restoreActive, expectedActive = this.active) {
    if (this.initializeParams) {
      const initialized = await this.rpc(context, { method: 'initialize', params: this.initializeParams });
      if (initialized.error || initialized.result?.protocolVersion !== this.initializeResult?.protocolVersion) {
        throw new Error('Serena initialize replay failed');
      }
      if (this.initialized) this.write(context, { method: 'notifications/initialized' });
    }
    if (this.loggingParams) {
      const response = await this.rpc(context, { method: 'logging/setLevel', params: this.loggingParams });
      if (response.error) throw new Error('Serena logging replay failed');
    }
    if (restoreActive && expectedActive) {
      const previous = expectedActive;
      const response = await this.rpc(context, { method: 'tools/call', params: { name: 'activate_project', arguments: { project: previous.root } } });
      this.active = null;
      if (!successful(response)) throw new Error('Serena active project replay failed');
      await this.confirmActive(context, previous);
      if (!this.active || this.active.root !== previous.root) throw new Error('Serena active project confirmation failed');
    }
    if (this.modes) {
      const response = await this.rpc(context, { method: 'tools/call', params: { name: 'switch_modes', arguments: this.modes } });
      if (!successful(response)) throw new Error('Serena modes replay failed');
    }
  }

  async rebuild(preparation, root, restoreActive, expectedActive = this.active) {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      if (this.starting) await this.starting;
      await this.drain();
      if (this.backend) await this.stop(this.backend);
      if (!restoreActive) this.active = null;
      const applied = await this.options.applySession({ root, preparation });
      if (!applied || applied.ok === false) throw new Error('Serena private session configuration unavailable');
      preparation.diagnostics = [...(preparation.diagnostics || []), ...(applied.diagnostics || [])];
      this.sessionDiagnostics = applied.diagnostics || [];
      const context = await this.start(false);
      try { await this.replayState(context, restoreActive, expectedActive); }
      catch (error) { context.failed = true; throw error; }
      this.generation = preparation.key;
      this.preparedProject = { root, preparation: { ...preparation, diagnostics: [...(preparation.diagnostics || [])] } };
    })().catch((error) => { this.active = null; throw error; }).finally(() => { this.restarting = null; });
    return this.restarting;
  }

  async prepare(root, restoreActive = true, target = this.active) {
    let preparation;
    const nonCpp = isNonCpp(target);
    try { preparation = nonCpp ? { status: 'not_applicable', diagnostics: [] } : await this.options.prepareProject(root); }
    catch (_) { preparation = { status: 'failed', diagnostics: ['Project preparation failed; continuing with limited native Serena functionality.'] }; }
    preparation = { ...preparation };
    preparation.key = JSON.stringify([root || null, preparation.status, preparation.generation || null,
      preparation.databaseDir || null, !!preparation.nativeRootDatabase]);
    if (preparation.key !== this.generation) await this.rebuild(preparation, root, restoreActive);
    else preparation.diagnostics = [...(preparation.diagnostics || []), ...(this.sessionDiagnostics || [])];
    return preparation;
  }

  activationSnapshot() {
    if (!this.active || this.activeContext !== this.backend || !this.preparedProject ||
      this.preparedProject.root !== this.active.root) return null;
    return { context: this.backend, project: { ...this.active }, root: this.preparedProject.root,
      preparation: { ...this.preparedProject.preparation, diagnostics: [...(this.preparedProject.preparation.diagnostics || [])] } };
  }

  async recoverActivation(snapshot, diagnostics) {
    if (!snapshot || this.closed) return;
    try {
      if (this.backend === snapshot.context && !this.backend.failed && !this.backend.exited) {
        await this.confirmActive(this.backend, snapshot.project);
        if (this.active?.root !== snapshot.root) throw new Error('Previous Serena project not confirmed');
      } else {
        // After B fails, reapply the saved actual generation for A; never activate A with B parameters.
        await this.rebuild(snapshot.preparation, snapshot.root, true, snapshot.project);
      }
    } catch (_) {
      this.active = null; this.activeContext = null;
      diagnostics.push('Previous project recovery failed; active project is unconfirmed. Reactivate the target project.');
      this.stderr.write('[codemap-boost-codex] Serena previous project recovery failed; active project is unconfirmed.\n');
    }
  }

  async tool(message, record) {
    const name = message.params?.name;
    let preparation;
    let target;
    const snapshot = name === 'activate_project' ? this.activationSnapshot() : null;
    if (name === 'activate_project') {
      try { target = await this.options.resolveProject(message.params?.arguments?.project); }
      catch (_) { target = { diagnostics: ['Project name did not resolve to a trusted absolute path; continuing with limited native Serena functionality.'] }; }
      if (target.root) {
        try { preparation = await this.prepare(target.root, false, target); }
        catch (error) {
          const diagnostics = [];
          await this.recoverActivation(snapshot, diagnostics);
          if (diagnostics.length) error.message += `; ${diagnostics.join(' ')}`;
          throw error;
        }
      }
      // Unresolved names must not trigger rebuilds that clear the old native project; native activation determines success or failure.
      else preparation = { status: 'unknown', diagnostics: [...(target.diagnostics || [])] };
    } else if (SEMANTIC_TOOLS.has(name) && this.active) preparation = await this.prepare(this.active.root);
    if (this.closed) return;
    if (record.cancelled) {
      if (snapshot && this.backend !== snapshot.context) await this.recoverActivation(snapshot, []);
      return;
    }
    const context = await this.start();
    const activeBeforeRequest = this.activeContext === context ? this.active : null;
    const response = await this.rpc(context, message, record);
    if (name === 'activate_project') {
      this.active = null;
      const expected = successful(response) ? target : activeBeforeRequest;
      try { await this.confirmActive(context, expected); }
      catch (_) {
        this.active = null;
        preparation.diagnostics = [...(preparation.diagnostics || []), 'Native active-project verification failed; subsequent reads must not infer the project from session cwd.'];
      }
      if (!successful(response) && snapshot && context !== snapshot.context) {
        await this.recoverActivation(snapshot, preparation.diagnostics);
      }
      // Language is known only after native autogen; non-C++ projects must not inherit earlier unknown/unsupported warnings.
      if (isNonCpp(this.active)) { preparation.status = 'not_applicable'; preparation.diagnostics = []; }
    } else if (name === 'get_current_config' && successful(response)) {
      // Explicit native user queries also update the confirmed project without changing their native results.
      await this.adoptActive(context, response, activeBeforeRequest);
    } else if (name === 'switch_modes' && successful(response)) this.modes = message.params.arguments;
    if (preparation && response.result) {
      const diagnostics = [...(preparation.diagnostics || [])].map(diagnosticText);
      if (!['ready', 'not_applicable'].includes(preparation.status)) diagnostics.unshift(`C++ compilation database preparation status: ${preparation.status || 'unknown'}; semantic readiness is unverified.`);
      if (diagnostics.length) response.result = { ...response.result,
        content: [...(response.result.content || []), { type: 'text', text: `[CodeMap Serena preparation]\n${diagnostics.join('\n')}` }] };
    }
    return response;
  }

  async handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }); return;
    }
    if (!message.method) {
      const callback = this.callbacks.get(message.id);
      if (callback) { this.callbacks.delete(message.id); this.write(callback.context, { ...message, id: callback.id }); this.changed(); }
      return;
    }
    if (!owns(message, 'id')) {
      if (message.method === 'notifications/cancelled') {
        const request = this.requests.get(message.params?.requestId);
        if (request) {
          request.cancelled = true;
          if (request.backendId && this.backend) this.write(this.backend, { ...message, params: { ...message.params, requestId: request.backendId } });
        } else if (this.backend && !this.backend.failed && !this.backend.exited) this.write(this.backend, message);
        return;
      }
      if (message.method === 'notifications/initialized') this.initialized = true;
      if (this.restarting) await this.restarting;
      this.write(await this.start(), message); return;
    }
    if (this.requests.has(message.id)) {
      this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Duplicate in-flight request ID' } }); return;
    }
    const record = { cancelled: false };
    this.requests.set(message.id, record);
    try {
      let response;
      if (message.method === 'tools/call') {
        const task = this.toolQueue.then(() => record.cancelled ? undefined : this.tool(message, record));
        // Timeout reports an error to the host but blocks the next tools/call until native completion or exit.
        this.toolQueue = task.catch(() => {}).then(() => this.drain()).catch(() => {});
        response = await task;
      } else {
        if (this.restarting) await this.restarting;
        if (record.cancelled) return;
        response = await this.rpc(await this.start(), message, record);
        if (message.method === 'initialize' && !response.error) {
          this.initializeParams = message.params; this.initializeResult = response.result;
        }
        if (message.method === 'logging/setLevel' && !response.error) this.loggingParams = message.params;
      }
      if (response && !record.cancelled) this.send({ ...response, id: message.id });
    } catch (error) {
      if (!record.cancelled) this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
    } finally { if (this.requests.get(message.id) === record) this.requests.delete(message.id); }
  }

  run() {
    return new Promise((resolve) => {
      this.resolveExit = resolve;
      this.lines = readline.createInterface({ input: this.input, crlfDelay: Infinity });
      this.lines.on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch (_) {
          this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return;
        }
        this.handle(message).catch((error) => this.stderr.write(`[codemap-boost-codex] Serena MCP: ${error.message}\n`));
      });
      this.lines.once('close', () => this.close(0));
      for (const stream of [this.input, this.output]) stream.once('error', () => this.close(1));
      this.signals = {};
      for (const signal of ['SIGINT', 'SIGTERM']) {
        this.signals[signal] = () => this.close(0); process.once(signal, this.signals[signal]);
      }
      this.start().catch((error) => { this.stderr.write(`[codemap-boost-codex] Serena startup: ${error.message}\n`); this.close(1); });
    });
  }

  async close(code) {
    if (this.closed) return;
    this.closed = true; this.changed();
    if (this.lines) this.lines.close();
    for (const [signal, handler] of Object.entries(this.signals || {})) process.removeListener(signal, handler);
    for (const record of this.pending.values()) { clearTimeout(record.timer); record.reject(new Error('MCP connection closed')); }
    this.pending.clear(); this.callbacks.clear();
    try {
      if (this.starting) await this.starting.catch(() => {});
      if (this.restarting) await this.restarting.catch(() => {});
      if (this.backend) await this.stop(this.backend, true);
    } catch (error) { this.stderr.write(`[codemap-boost-codex] Serena close: ${error.message}\n`); code = 1; }
    if (this.resolveExit) this.resolveExit(code);
  }
}

module.exports = { SerenaMcpProxy, SEMANTIC_TOOLS, successful, resultText };
