'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { PassThrough, Writable } = require('node:stream');
const readline = require('node:readline');

const IDLE_MS = 60_000;
const START_MS = 30_000;
const REQUEST_MS = 20 * 60_000;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const ENDPOINTS = ['x64dbg', 'x32dbg', 'ghidra', 'windbg', 'ida-mcp'];
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const SECRET = /^[a-f0-9]{64}$/;
const LOCK_FILE = /^\d{12}\.json$/;
const WINDBG_FALLBACK_LINE = /(?:^|\n)Official WinDbg proxy could not start \([A-Za-z]+Error\)\. Using the saved legacy cdb\/kd compatibility backend\.\r?\n/;
const WINDBG_FALLBACK_MESSAGE = 'Dbg: Official WinDbg proxy could not start. Using the saved legacy cdb/kd compatibility backend.';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const token = () => randomBytes(16).toString('hex');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkId(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) {
    throw new Error('A valid Dbg session ID is required. Set CODEX_THREAD_ID, CODEX_SESSION_ID or --session ID.');
  }
  return id;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function atomicJson(file, value, link = false) {
  const temporary = path.join(path.dirname(file), token() + '.tmp');
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    if (link) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function privateDirectory(directory, create) {
  if (create) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw new Error('Dbg on-demand state directory is not private.');
    }
    return true;
  } catch (error) {
    if (!create && error.code === 'ENOENT') return false;
    throw error;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function live(owner) {
  return owner !== null && !owner.closed && pidAlive(owner.pid);
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function socketAddress(instance) {
  return process.platform === 'win32' ? '\\\\.\\pipe\\dbg-codex-' + instance : '/tmp/dbg-codex-' + instance + '/ipc';
}

function removeSocket(instance) {
  if (process.platform === 'win32') return;
  const address = socketAddress(instance);
  try {
    if (privateDirectory(path.dirname(address), false)) {
      try { fs.unlinkSync(address); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.rmdirSync(path.dirname(address));
    }
  } catch (_) {}
}

class SessionState {
  constructor(id, root) {
    this.root = root || path.join(os.homedir(), '.dbg-codex-on-demand');
    this.directory = path.join(this.root, hash(checkId(id)));
    this.turnFile = path.join(this.directory, 'turn.json');
  }

  ensure(create = false) {
    return privateDirectory(this.root, create) && privateDirectory(this.directory, create);
  }

  owner() {
    if (!this.ensure()) return null;
    const name = fs.readdirSync(this.directory).filter((entry) => LOCK_FILE.test(entry)).sort().at(-1);
    if (!name) return null;
    const file = path.join(this.directory, name);
    const owner = readJson(file);
    if (!owner || owner.closed !== true && (!Number.isInteger(owner.pid) || owner.pid < 1 ||
        owner.pid > 0x7fffffff || !TOKEN.test(owner.instance) || !SECRET.test(owner.secret))) {
      throw new Error('Invalid Dbg on-demand owner record.');
    }
    return { ...owner, file, sequence: Number(name.slice(0, 12)) };
  }

  claim() {
    this.ensure(true);
    const previous = this.owner();
    if (live(previous)) return null;
    const sequence = (previous?.sequence || 0) + 1;
    const file = path.join(this.directory, String(sequence).padStart(12, '0') + '.json');
    const owner = { pid: process.pid, instance: token(), secret: randomBytes(32).toString('hex') };
    // A hard link publishes a complete record exactly once. Keeping used slots fences out stale contenders
    // even when they resume after the current broker has already retired and a successor has claimed ownership.
    try { atomicJson(file, owner, true); }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    if (previous && !previous.closed) {
      removeSocket(previous.instance);
      try { atomicJson(previous.file, { closed: true }); } catch (_) {}
    }
    return { ...owner, file };
  }

  turn() {
    return this.ensure() ? readJson(this.turnFile) : null;
  }

  submit(turnId, restart = false) {
    this.ensure(true);
    const turn = this.activeTurn();
    if (turn?.id === turnId && !(restart && turn.closed)) return;
    atomicJson(this.turnFile, { id: turnId, generation: token() });
  }

  advance(turn, final) {
    let current = turn;
    while (current?.root === turn.root && !current.closed) {
      try {
        atomicJson(this.endedFile(current.generation), final ? { final: true } : { next: token() }, true);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!final) return;
        current = this.activeTurn();
      }
    }
  }

  endedFile(generation) {
    if (!TOKEN.test(generation)) throw new Error('Invalid Dbg turn generation.');
    return path.join(this.directory, 'ended-' + generation);
  }

  activeTurn() {
    const turn = this.turn();
    if (!turn) return null;
    let generation = turn.generation;
    for (;;) {
      const ended = readJson(this.endedFile(generation));
      if (!ended || ended.final) return { ...turn, root: turn.generation, generation, closed: Boolean(ended?.final) };
      generation = ended.next;
    }
  }

  turnOpen(generation) {
    const current = this.activeTurn();
    return !current?.closed && (current?.generation ?? null) === generation;
  }
}

class RpcFailure extends Error {
  constructor(rpc) {
    super(rpc.message);
    this.rpc = rpc;
  }
}

function failure(error) {
  return { error: error.rpc || { code: -32603, message: error.message } };
}

class Endpoint {
  constructor(name, runMcp, idleMs, retire) {
    this.input = new PassThrough();
    this.output = new PassThrough();
    this.lines = readline.createInterface({ input: this.output, crlfDelay: Infinity });
    this.lines.on('line', (line) => this.receive(JSON.parse(line)));
    this.pending = new Map();
    this.sequence = 0;
    this.calls = 0;
    this.idleMs = idleMs;
    this.retire = retire;
    let stderrTail = '';
    this.mcp = runMcp(name, {
      input: this.input, output: this.output, keepAlive: true, watchProcess: false,
      stderr: new Writable({ write: (chunk, _encoding, callback) => {
        if (name === 'windbg' && !this.legacyFallback) {
          const text = stderrTail + chunk.toString('utf8');
          this.legacyFallback = WINDBG_FALLBACK_LINE.test(text);
          stderrTail = text.slice(-256);
        }
        callback();
      } }),
    });
  }

  get unavailable() {
    return this.failedInitialize || this.mcp.terminalError;
  }

  get busy() {
    return Boolean(this.calls || this.mcp.starting || this.mcp.hostRequests.size ||
      this.mcp.backend?.pending.size || this.mcp.backend?.callbacks.size);
  }

  receive(message) {
    if (message.method && Object.hasOwn(message, 'id')) {
      // This CLI is not a sampling, approval or elicitation host. A real MCP error lets the server
      // enforce its existing safety policy without treating the callback as approved.
      this.input.write(JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        error: { code: -32601, message: 'Client callbacks are unsupported by the Dbg on-demand CLI.' },
      }) + '\n');
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new RpcFailure(message.error));
    else pending.resolve(message.result);
  }

  rpc(method, params, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++this.sequence;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    if (!signal) return promise;
    return abortable(promise, signal).finally(() => {
      if (signal.aborted && this.pending.delete(id) && !this.retiring) {
        this.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled',
          params: { requestId: id } }) + '\n');
      }
    });
  }

  initialize() {
    this.initializing ??= this.rpc('initialize', {
      protocolVersion: '2024-11-05', clientInfo: { name: 'dbg-codex', version: '1' }, capabilities: {},
    }).then(() => {
      if (!this.retiring) this.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    }).catch((error) => {
      this.failedInitialize = true;
      throw error;
    });
    return this.initializing;
  }

  async listTools(signal) {
    const first = await this.rpc('tools/list', {}, signal);
    if (first?.nextCursor == null) return first;
    const tools = [...first.tools];
    const visited = new Set();
    let cursor = first.nextCursor;
    while (cursor != null) {
      if (typeof cursor !== 'string' || visited.has(cursor) || visited.size >= 128) {
        throw new Error('Dbg MCP tools/list returned an invalid cursor.');
      }
      visited.add(cursor);
      const page = await this.rpc('tools/list', { cursor }, signal);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    }
    const { nextCursor, ...result } = first;
    return { ...result, tools };
  }

  async execute(request, signal) {
    clearTimeout(this.timer);
    this.calls++;
    try {
      await abortable(this.initialize(), signal);
      if (this.retiring) throw new Error('Dbg endpoint is shutting down.');
      if (signal.aborted) throw signal.reason;
      return request.action === 'tools' ? await this.listTools(signal) :
        await this.rpc('tools/call', { name: request.tool, arguments: request.args }, signal);
    } finally {
      this.calls--;
      if (!this.calls && !this.retiring) {
        if (signal.aborted) this.retire();
        else this.timer = setTimeout(() => this.expire(), this.unavailable ? 0 : this.idleMs);
      }
    }
  }

  expire() {
    if (this.busy) this.timer = setTimeout(() => this.expire(), 50);
    else this.retire();
  }

  close() {
    clearTimeout(this.timer);
    for (const pending of this.pending.values()) pending.reject(new Error('Dbg endpoint was stopped.'));
    this.pending.clear();
    this.lines.close();
    this.input.end();
    this.output.end();
    return this.mcp.close();
  }
}

// IPC carries one bounded JSON line in each direction. Clients keep their read side open until the result.
function readMessage(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let timeout;
    const finish = (error, value) => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve(value);
    };
    const onClose = () => finish(new Error('Dbg broker connection closed.'));
    const onData = (chunk) => {
      const newline = chunk.indexOf(10);
      length += newline < 0 ? chunk.length : newline;
      if (length > MAX_MESSAGE_BYTES) return finish(new Error('Dbg broker message is too large.'));
      chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline));
      if (newline < 0) return;
      let value;
      try { value = JSON.parse(Buffer.concat(chunks, length)); }
      catch (_) { return finish(new Error('Invalid Dbg broker message.')); }
      finish(null, value);
    };
    socket.once('close', onClose);
    socket.on('data', onData);
    if (timeoutMs) timeout = setTimeout(() => finish(new Error('Dbg broker did not respond in time.')), timeoutMs);
  });
}

function authorized(received, secret) {
  return typeof received === 'string' && SECRET.test(received) &&
    timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(secret, 'hex'));
}

function checkTool(tool) {
  if (typeof tool !== 'string' || !tool.length || tool.length > 256 || /[\u0000-\u001f\u007f]/.test(tool)) {
    throw new Error('Invalid MCP tool name.');
  }
  return tool;
}

function checkEndpoint(endpoint) {
  if (!ENDPOINTS.includes(endpoint)) throw new Error('Unknown Dbg endpoint. Available endpoints: ' + ENDPOINTS.join(', '));
  return endpoint;
}

class Broker {
  constructor(state, owner, options) {
    this.state = state;
    this.owner = owner;
    this.options = options;
    this.generation = options.generation;
    this.endpoints = new Map();
    this.server = net.createServer((socket) => this.accept(socket));
  }

  async accept(socket) {
    socket.on('error', () => socket.destroy());
    const controller = new AbortController();
    socket.once('close', () => controller.abort(new Error('Dbg tool client disconnected.')));
    let response;
    let timer;
    try {
      const request = await readMessage(socket, 5000);
      if (!authorized(request?.secret, this.owner.secret)) return socket.destroy();
      if (request.action === 'tools' || request.action === 'call') {
        timer = setTimeout(() => controller.abort(new Error('Dbg tool request timed out.')), this.options.requestMs ?? REQUEST_MS);
      }
      response = await this.dispatch(request, controller.signal);
    } catch (error) {
      response = failure(error);
    } finally {
      clearTimeout(timer);
    }
    socket.end(JSON.stringify(response) + '\n');
  }

  async dispatch(request, signal) {
    if (request.action === 'status') return { result: {
      running: true, pid: process.pid, stopping: Boolean(this.stopping),
      endpoints: Array.from(this.endpoints, ([name, endpoint]) => ({
        name, backendPid: endpoint.mcp.backend?.child.pid ?? null, busy: endpoint.busy,
        stopping: Boolean(endpoint.retiring),
      })),
    } };
    if (request.action === 'stop') {
      if (request.hook) {
        if ((this.state.turn()?.generation ?? null) !== request.turn ||
            (!request.sessionEnd && this.generation !== undefined && this.generation !== request.generation)) {
          return { result: { stopped: false } };
        }
      }
      const stopping = this.stop();
      if (!request.hook) await stopping;
      return { result: { stopped: true } };
    }
    if (!['tools', 'call'].includes(request.action)) throw new Error('Unknown Dbg broker action.');
    const name = checkEndpoint(request.endpoint);
    if (request.action === 'call') {
      checkTool(request.tool);
      if (!isObject(request.args)) throw new Error('MCP arguments must be a JSON object.');
    }
    if (this.stopping) return { retry: true };
    if (!this.state.turnOpen(request.generation)) return { error: {
      code: -32000, message: 'This Dbg turn has ended or been superseded. Invoke the tool from the active turn.',
    } };
    if (signal.aborted) throw signal.reason;
    if (this.generation !== undefined && this.generation !== request.generation) {
      // A new prompt or a continued Stop generation must reconnect before entering an old endpoint.
      await this.stop();
      return { retry: true };
    }
    if (request.identity !== this.options.identity) {
      if (Array.from(this.endpoints.values()).some((endpoint) => endpoint.busy)) {
        throw new Error('Dbg launcher or runtime location changed while a request is active.');
      }
      await this.stop();
      return { retry: true };
    }
    let endpoint = this.endpoints.get(name);
    while (endpoint) {
      const observed = endpoint.mcp.observedFingerprint;
      const changed = observed && this.options.fingerprint && observed !== this.options.fingerprint(name);
      if (changed && endpoint.busy && !endpoint.retiring) {
        throw new Error('Dbg endpoint deployment changed while a request is active.');
      }
      if (!endpoint.retiring && !endpoint.unavailable && !changed) break;
      if (!endpoint.retiring && endpoint.busy) throw new Error('Dbg endpoint is finishing a failed request.');
      await this.retire(name, endpoint);
      if (this.stopping) return { retry: true };
      if (!this.state.turnOpen(request.generation)) throw new Error('This Dbg turn has ended or been superseded.');
      if (signal.aborted) throw signal.reason;
      endpoint = this.endpoints.get(name);
    }
    if (!endpoint) {
      endpoint = new Endpoint(name, this.options.runMcp, this.options.idleMs ?? IDLE_MS, () => this.retire(name, endpoint));
      this.endpoints.set(name, endpoint);
    }
    clearTimeout(this.unused);
    this.generation = request.generation;
    const response = await endpoint.execute(request, signal).then((result) => ({ result }), failure);
    if (endpoint.legacyFallback) response.diagnostic = 'windbg-legacy-fallback';
    return response;
  }

  retire(name, endpoint) {
    endpoint.retiring ??= Promise.resolve().then(() => endpoint.close()).then(() => {
      this.endpoints.delete(name);
      if (!this.endpoints.size) this.stop();
    });
    return endpoint.retiring;
  }

  stop() {
    if (this.stopping) return this.stopping;
    clearTimeout(this.unused);
    clearInterval(this.generationWatch);
    this.stopping = Promise.resolve().then(async () => {
      await Promise.all(Array.from(this.endpoints, ([name, endpoint]) => this.retire(name, endpoint)));
      this.server.close();
    });
    return this.stopping;
  }

  async start() {
    const address = socketAddress(this.owner.instance);
    if (process.platform !== 'win32') privateDirectory(path.dirname(address), true);
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(address, resolve);
    });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const stop = () => this.stop();
    for (const signal of signals) process.on(signal, stop);
    this.unused = setTimeout(stop, START_MS);
    this.generationWatch = setInterval(() => {
      if (this.generation === undefined) return;
      try { if (!this.state.turnOpen(this.generation)) this.stop(); }
      catch (_) { this.stop(); }
    }, 100);
    this.generationWatch.unref();
    await new Promise((resolve) => this.server.once('close', resolve));
    for (const signal of signals) process.off(signal, stop);
  }
}

async function serve(state, options) {
  const owner = state.claim();
  if (!owner) return;
  try {
    if (state.turnOpen(options.generation)) await new Broker(state, owner, options).start();
  }
  finally {
    removeSocket(owner.instance);
    atomicJson(owner.file, { closed: true });
  }
}

async function connect(owner, timeoutMs) {
  const socket = net.connect(socketAddress(owner.instance));
  socket.on('error', () => socket.destroy());
  return new Promise((resolve) => {
    const finish = (connection) => {
      clearTimeout(timeout);
      socket.off('connect', onConnect);
      socket.off('close', onClose);
      if (!connection) socket.destroy();
      resolve(connection);
    };
    const onConnect = () => finish(socket);
    const onClose = () => finish(null);
    const timeout = setTimeout(onClose, timeoutMs);
    socket.once('connect', onConnect);
    socket.once('close', onClose);
  });
}

async function requestBroker(state, id, request, options, mayStart) {
  const deadline = Date.now() + (request.hook ? 1000 : mayStart ? START_MS : 10000);
  let spawned;
  for (;;) {
    if (mayStart && !state.turnOpen(request.generation)) throw new Error('This Dbg turn has ended or been superseded.');
    const owner = state.owner();
    if (live(owner)) {
      const socket = await connect(owner, 250);
      if (socket) {
        try {
          const response = readMessage(socket, mayStart ? 0 : Math.max(1, deadline - Date.now()));
          socket.write(JSON.stringify({ ...request, secret: owner.secret }) + '\n');
          const value = await response;
          // This is the sole retry after a write. The broker explicitly refused before dispatch.
          if (!isObject(value)) throw new Error('Invalid Dbg broker response.');
          if (!value.retry) return value;
        } finally { socket.destroy(); }
      }
    } else if (!mayStart) {
      return { result: request.action === 'status' ? { running: false, endpoints: [] } : { stopped: false } };
    } else if (!spawned || spawned.exitCode !== null || spawned.signalCode !== null) {
      const env = { ...process.env };
      env.DBG_BROKER_GENERATION = request.generation ?? '';
      if (env.DBG_HOME) env.DBG_HOME = path.resolve(env.DBG_HOME);
      if (env.DBG_PYTHON && /[\\/]/.test(env.DBG_PYTHON)) env.DBG_PYTHON = path.resolve(env.DBG_PYTHON);
      spawned = spawn(process.execPath, [options.entry || path.join(__dirname, 'launch.cjs'), '_broker', '--session', id], {
        cwd: os.homedir(), detached: true, windowsHide: true, stdio: 'ignore', env,
      });
      spawned.on('error', () => {});
      spawned.unref();
    }
    if (Date.now() >= deadline) throw new Error('Dbg broker could not be reached.');
    await delay(40);
  }
}

function parseCli(argv) {
  const [action, ...args] = argv;
  const request = { action };
  if (action === 'tools' || action === 'call') request.endpoint = checkEndpoint(args.shift());
  if (action === 'call') request.tool = checkTool(args.shift());
  const flags = new Map();
  while (args.length) {
    const flag = args.shift();
    if (!['--session', '--args-file', '--args-json'].includes(flag) || flags.has(flag) || !args.length) {
      throw new Error('Usage: dbg tools ENDPOINT | dbg call ENDPOINT TOOL (--args-file PATH | --args-json JSON) | dbg status | dbg stop. Optional: --session ID.');
    }
    flags.set(flag, args.shift());
  }
  const file = flags.get('--args-file');
  const json = flags.get('--args-json');
  const argumentOptions = Number(file !== undefined) + Number(json !== undefined);
  if (action === 'call' ? argumentOptions !== 1 : argumentOptions !== 0) {
    throw new Error('Only dbg call requires exactly one --args-file or --args-json option.');
  }
  const id = checkId(flags.get('--session') ?? (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID));
  if (action === 'call') {
    try {
      if (file !== undefined) {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_MESSAGE_BYTES) throw new Error();
      }
      request.args = JSON.parse(file === undefined ? json : fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (_) { throw new Error('Could not read MCP arguments as JSON.'); }
    if (!isObject(request.args)) throw new Error('MCP arguments must be a JSON object.');
  }
  return { id, request };
}

function hookContext() {
  const launcher = JSON.stringify(path.join(__dirname, 'launch.cjs').split(path.sep).join('/'));
  return [
    'Dbg endpoints are available on demand in this Codex session: ' + ENDPOINTS.join(', ') + '.',
    'Discover tools with node ' + launcher + ' tools ENDPOINT. Invoke with node ' + launcher + ' call ENDPOINT TOOL --args-file PATH.',
    'The same launcher supports status and stop; commands use the current Codex session by default.',
    'After 60 seconds idle, the endpoint closes. The next invocation starts a new connection; verify its debugger target before resuming work.',
    'If a response reports needs_doctor, run node ' + launcher + ' doctor to prepare Python, then discover tools again.',
    'Sampling and approval callbacks are unsupported in this launcher. Keep WinDbg secure mode enabled.',
  ].join(' ');
}

async function lifecycleHook(options) {
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 128 * 1024) throw new Error('Oversized hook input');
      chunks.push(chunk);
    }
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const name = event.hook_event_name;
    if (name === 'UserPromptSubmit' || name === 'SubagentStart') {
      if (name === 'SubagentStart') {
        const agent = checkId(event.agent_id);
        new SessionState(agent, options.root).submit(agent, true);
      } else {
        const state = new SessionState(checkId(event.session_id), options.root);
        state.submit(checkId(event.turn_id));
      }
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: name, additionalContext: hookContext() } }) + '\n');
    } else if (['Stop', 'Interrupt', 'SessionEnd', 'SubagentStop'].includes(name)) {
      const id = checkId(name === 'SubagentStop' ? event.agent_id : event.session_id);
      const state = new SessionState(id, options.root);
      const sessionEnd = name === 'SessionEnd' || name === 'SubagentStop';
      if (name === 'SubagentStop' && !state.turn()) state.submit(id);
      const turn = state.activeTurn();
      if (!sessionEnd && turn?.id !== checkId(event.turn_id)) return;
      if (turn) state.advance(turn, sessionEnd);
      await requestBroker(state, id, { action: 'stop', hook: true, sessionEnd,
        turn: turn?.root ?? null, generation: turn?.generation ?? null }, options, false);
    }
  } catch (_) {
    // Overwrite one bounded diagnostic, without event payloads, credentials or filesystem errors.
    const root = options.root || path.join(os.homedir(), '.dbg-codex-on-demand');
    try {
      privateDirectory(root, true);
      atomicJson(path.join(root, 'hook-error.json'), { at: new Date().toISOString(), error: 'Dbg lifecycle hook failed.' });
    } catch (_) {}
  }
}

async function main(argv, options) {
  if (argv[0] === 'lifecycle-hook') return lifecycleHook(options);
  const { id, request } = parseCli(argv);
  const state = new SessionState(id, options.root);
  if (request.action === '_broker') {
    const generation = process.env.DBG_BROKER_GENERATION || null;
    if (state.turnOpen(generation)) return serve(state, { ...options, generation });
    return;
  }
  const mayStart = request.action === 'tools' || request.action === 'call';
  if (mayStart) {
    request.identity = options.identity;
    request.generation = state.activeTurn()?.generation ?? null;
  }
  const response = await requestBroker(state, id, request, options, mayStart);
  if (response.diagnostic === 'windbg-legacy-fallback') process.stderr.write(WINDBG_FALLBACK_MESSAGE + '\n');
  process.stdout.write(JSON.stringify(response.error ? { error: response.error } : response.result) + '\n');
  if (response.error || response.result?.isError === true) process.exitCode = 1;
}

module.exports = { ENDPOINTS, IDLE_MS, main };
