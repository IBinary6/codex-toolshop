'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { SafeError } = require('./config.cjs');
const MAX_LINE = 8 * 1024 * 1024;
const cancelled = () => new SafeError('Research Tools call was cancelled or timed out.');

// A gateway owns only the backend it started. stdout carries MCP; stderr is always discarded to avoid logging user thoughts.
class ChildTransport {
  constructor(provider, launch, options = {}) {
    this.provider = provider;
    this.launch = launch;
    this.spawn = options.spawn || spawn;
    this.pending = new Map();
    this.nextId = 1;
    this.child = undefined;
    this.owned = new Set();
    this.terminations = new WeakMap();
    this.closed = false;
  }

  async start(signal) {
    if (this.child) return;
    if (this.closed || signal.aborted) throw cancelled();
    const spec = await this.launch(signal);
    if (this.closed || signal.aborted) throw cancelled();
    let child;
    try { child = this.spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env || process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false }); }
    catch { throw this.failed(); }
    this.child = child;
    this.owned.add(child);
    let buffer = '';
    const fail = () => {
      if (this.child !== child) return;
      this.child = undefined;
      for (const entry of this.pending.values()) entry.reject(this.failed());
      this.pending.clear();
      if (child.pid && child.exitCode === null && child.signalCode === null) this.terminate(child);
    };
    child.stderr.on('data', () => {});
    child.stdin.on('error', fail);
    child.once('error', error => {
      if (error.code === 'ENOENT' && this.provider === 'fetch') {
        if (this.child !== child) return;
        this.child = undefined;
        for (const entry of this.pending.values()) entry.reject(new SafeError('Fetch requires uvx. Install uv, ensure uvx is on PATH, and retry.'));
        this.pending.clear();
      } else fail();
    });
    child.once('exit', () => { fail(); this.owned.delete(child); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary).replace(/\r$/, '');
        buffer = buffer.slice(boundary + 1);
        if (Buffer.byteLength(line) > MAX_LINE) { fail(); this.terminate(child); return; }
        let message;
        try { message = JSON.parse(line); } catch { fail(); this.terminate(child); return; }
        if (!message || message.jsonrpc !== '2.0') { fail(); this.terminate(child); return; }
        if (typeof message.method === 'string') {
          // The gateway does not advertise sampling/elicitation, so backend requests do not become new client-side effects.
          if (Object.hasOwn(message, 'id')) {
            try { this.write(child, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported method' } }); }
            catch { fail(); return; }
          }
          continue;
        }
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          if (message.error || !Object.hasOwn(message, 'result')) entry.reject(this.failed());
          else entry.resolve(message.result);
        }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE) { fail(); this.terminate(child); }
    });
  }

  failed() { return new SafeError(`${this.provider} local MCP backend failed; check the runtime or retry later.`); }

  write(child, message) {
    if (!child || child.exitCode !== null || child.stdin.destroyed) throw this.failed();
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, params, signal, notification = false) {
    if (signal.aborted || this.closed) throw cancelled();
    if (!this.child) throw this.failed();
    const child = this.child;
    if (notification) { this.write(child, { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); return; }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', abort);
      const abort = () => {
        this.pending.delete(id);
        try { this.write(child, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Cancelled' } }); } catch {}
        cleanup();
        reject(cancelled());
      };
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
      signal.addEventListener('abort', abort, { once: true });
      try { this.write(child, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }

  terminate(child) {
    // The PID comes from a ChildProcess spawned by this object; only a live owned child may enter tree termination.
    if (this.terminations.has(child)) return this.terminations.get(child);
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const terminating = new Promise(resolve => {
      let finished = false;
      const done = () => { if (!finished) { finished = true; clearTimeout(timer); resolve(); } };
      child.once('exit', done);
      const timer = setTimeout(done, 2000);
      if (process.platform === 'win32') {
        const killer = spawn(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, shell: false });
        killer.once('error', () => { child.kill(); });
      } else child.kill('SIGKILL');
    });
    this.terminations.set(child, terminating);
    return terminating;
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(cancelled());
    this.pending.clear();
    this.child = undefined;
    this.closing = Promise.allSettled([...this.owned].map(child => this.terminate(child)));
    return this.closing;
  }
}

module.exports = { ChildTransport };
