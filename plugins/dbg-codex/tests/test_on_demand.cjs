'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { findPython } = require('../scripts/launch.cjs');
const { IDLE_MS } = require('../scripts/on_demand.cjs');

const python = findPython({ absolute: true })?.[0];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const launch = path.resolve(__dirname, '../scripts/launch.cjs');
const runtime = path.resolve(__dirname, '../scripts/on_demand.cjs');
const version = require('../.codex-plugin/plugin.json').version;

const backendSource = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const name = process.argv[2];
const file = process.env.FIXTURE_EVENTS;
const record = (event, data) => fs.appendFileSync(file, JSON.stringify({ name, pid: process.pid, event, data }) + '\n');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
child.unref();
record('start', child.pid);
let count = 0;
let callbackId;
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    record('initialize', req.params.capabilities);
    send(req.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name, version: 'fixture' } });
  } else if (req.method === 'tools/list') {
    send(req.id, { tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] });
  } else if (req.method === 'tools/call') {
    const args = req.params.arguments;
    record('call', args);
    const result = { content: [{ type: 'text', text: 'fixture' }], structuredContent: { count: ++count, args, name } };
    if (args.crash) process.exit(5);
    if (args.hold) return;
    if (args.fallbackDiagnostic) {
      process.stderr.write('secret fixture stderr\nOfficial WinDbg proxy could not start ');
      process.stderr.write('(FileNotFoundError). Using the saved legacy cdb/kd compatibility backend.\n');
    }
    if (args.callback) {
      callbackId = req.id;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'approval', method: 'sampling/createMessage', params: {} }) + '\n');
      return;
    }
    if (args.error) result.isError = true;
    if (args.waitForFile) {
      const timer = setInterval(() => {
        if (!fs.existsSync(args.waitForFile)) return;
        clearInterval(timer);
        send(req.id, result);
      }, 20);
    } else setTimeout(() => send(req.id, result), args.delay || 0);
  } else if (req.method === 'notifications/cancelled') {
    record('cancelled', req.params.requestId);
  } else if (req.id === 'approval') {
    record('callback', req.error);
    send(callbackId, { content: [], isError: true, structuredContent: { callback: req.error } });
  }
});
`;

function alive(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform === 'linux') {
    // Containers may have a PID 1 which leaves dead grandchildren as zombies.
    try { return !/\) Z /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return true;
}

async function eventually(check, description) {
  const deadline = Date.now() + 8000;
  do {
    const result = await check();
    if (result) return result;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(description);
}

function fixture(t, idleMs = 1500, requestMs = 15000, preparation = 'warm') {
  assert.ok(python, 'ProcessOwner integration requires Python 3.11+');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-on-demand-'));
  const root = path.join(temporary, 'private');
  const events = path.join(temporary, 'events');
  const entry = path.join(temporary, 'fixture-cli.cjs');
  const backend = path.join(temporary, 'fixture-backend.cjs');
  const policyDrift = preparation === 'policy-drift';
  let fixtureLaunch = launch;
  if (preparation === 'cold' || preparation === 'blocked' || policyDrift) {
    const scripts = path.join(temporary, 'copy', 'scripts');
    fs.cpSync(path.dirname(launch), scripts, { recursive: true });
    fs.cpSync(path.resolve(__dirname, '../.codex-plugin'), path.join(scripts, '..', '.codex-plugin'), { recursive: true });
    fixtureLaunch = path.join(scripts, 'launch.cjs');
    const doctor = path.join(scripts, 'doctor.py');
    if (policyDrift) fs.renameSync(doctor, path.join(scripts, 'doctor_impl.py'));
    const finishDoctor = policyDrift ? `
from discovery import Installation
from doctor_impl import run_doctor
def install(name):
    def recipe(installations, context):
        result = {"runtime": {"type": "stdio", "command": [os.environ["FIXTURE_NODE"], os.environ["FIXTURE_BACKEND"], name]}}
        if name == "windbg":
            result.update(backend="native", backend_mode=context.config["windbg"]["backend"])
        return result
    return recipe
recipes = {name: (name, install(name)) for name in ("ghidra", "ida-mcp", "windbg")}
def discover_fixture(paths):
    return [Installation(name, state_file.parent) for name in recipes]
result = run_doctor(state_file.parent, selected=sys.argv[3], recipe_map=recipes, discover_fn=discover_fixture)
raise SystemExit(result["status"] != "complete")
` : `
state = json.loads(state_file.read_text(encoding="utf-8"))
state["plugin_version"] = ${JSON.stringify(version)}
updated = state_file.with_suffix(".tmp")
updated.write_text(json.dumps(state), encoding="utf-8")
updated.replace(state_file)
`;
    fs.writeFileSync(doctor, `
import json, os, subprocess, sys, time
from pathlib import Path
state_file = Path(os.environ["DBG_HOME"]) / "state.json"
grandchild = None
if ${preparation === 'blocked' ? 'True' : 'False'}:
    grandchild = subprocess.Popen([os.environ["FIXTURE_NODE"], "-e", "setInterval(() => {}, 1000)"])
with open(os.environ["FIXTURE_EVENTS"], "a", encoding="utf-8") as events:
    events.write(json.dumps({"name": "doctor", "pid": os.getpid(), "event": "doctor",
        "data": {"args": sys.argv[1:], "parent": os.getppid(), "child": grandchild.pid if grandchild else None}}) + "\\n")
if grandchild:
    time.sleep(120)
${finishDoctor}
`);
  }
  fs.writeFileSync(backend, backendSource);
  const tools = Object.fromEntries(['ghidra', 'ida-mcp'].map((name) => [name, {
    status: 'deployed', runtime: { type: 'stdio', command: [process.execPath, backend, name] },
  }]));
  if (policyDrift) {
    delete tools.ghidra;
    tools.windbg = { status: 'deployed', backend: 'legacy', backend_mode: 'legacy',
      runtime: { type: 'stdio', command: [python, '-m', 'mcp_windbg'] } };
    fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify({ windbg: { backend: 'native' } }));
  }
  fs.writeFileSync(path.join(temporary, 'state.json'), JSON.stringify({
    schema_version: 1, plugin_version: preparation === 'warm' || policyDrift ? version : 'stale',
    auto_windbg_backend: policyDrift ? 'legacy' : 'auto',
    runtimes: preparation === 'missing' ? {} : { fixture: python }, tools,
  }));
  fs.writeFileSync(entry, `
    const fs = require('node:fs');
    const { runMcp } = require(${JSON.stringify(fixtureLaunch)});
    const { main } = require(${JSON.stringify(runtime)});
    const forbidden = () => { throw new Error('Fixture never deploys any debugger'); };
    (async () => {
      const gate = process.argv[2] === '_broker' && process.env.FIXTURE_CLAIM_GATE;
      if (gate) {
        fs.writeFileSync(gate + '.entered', '');
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(gate) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        if (!fs.existsSync(gate)) throw new Error('Fixture claim gate timed out');
      }
      await main(process.argv.slice(2), {
        root: ${JSON.stringify(root)}, entry: __filename, idleMs: ${idleMs}, requestMs: ${requestMs},
        identity: process.env.FIXTURE_IDENTITY || 'first',
        runMcp: (name, options) => runMcp(name, { ...options, ensurePython: forbidden, doctor: forbidden,
          ${preparation === 'missing' ? 'findPythonAsync: async () => null,' : ''}
          ${preparation === 'warm' || preparation === 'missing' ? 'runOwnedDoctor: forbidden,' : ''}
        })
      });
      if (gate) fs.writeFileSync(gate + '.done', '');
    })().catch((error) => { process.stderr.write(error.message + '\\n'); process.exitCode = 1; });
  `);
  const env = { ...process.env, DBG_HOME: temporary, FIXTURE_EVENTS: events, FIXTURE_NODE: process.execPath,
    FIXTURE_BACKEND: backend, CODEX_SESSION_ID: 'session-a' };
  delete env.DBG_NODE;
  delete env.DBG_PYTHON;
  const sessions = new Set(['session-a', 'session-b']);
  const readEvents = () => fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const start = (args, { input = '', session = 'session-a', thread = session, identity = 'first', claimGate = '' } = {}) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...env, CODEX_SESSION_ID: session, CODEX_THREAD_ID: thread, FIXTURE_IDENTITY: identity,
        FIXTURE_CLAIM_GATE: claimGate },
      windowsHide: true, stdio: 'pipe',
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(input);
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, result: stdout.trim() ? JSON.parse(stdout) : null }));
    });
    return { child, finished };
  };
  const run = (...args) => start(args).finished;
  const status = async (session = 'session-a') => (await run('status', '--session', session)).result;
  const call = (name, args) => start(['call', name, 'fixture', '--args-json', JSON.stringify(args)]);
  const hook = (event, turn, session = 'session-a', agent) => {
    sessions.add(session);
    if (agent) sessions.add(agent);
    return start(['lifecycle-hook'], { input: JSON.stringify({
      hook_event_name: event, session_id: session, turn_id: turn, agent_id: agent,
    }) }).finished;
  };
  const quiet = async (operation) => {
    const result = await operation;
    assert.equal(result.code, 0);
    assert.equal(result.stdout + result.stderr, '');
  };
  t.after(async () => {
    const statuses = await Promise.all(Array.from(sessions, status));
    await Promise.all(Array.from(sessions, (session) => run('stop', '--session', session)));
    const pids = [...statuses.map((info) => info?.pid),
      ...readEvents().flatMap((e) => {
        if (e.event === 'start') return [e.pid, e.data];
        if (e.event === 'doctor') return [e.pid, e.data.parent, e.data.child];
        return [];
      })].filter(Boolean);
    await eventually(() => pids.every((pid) => !alive(pid)), 'all fixture processes should exit');
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });
  return { root, temporary, run, start, call, status, readEvents, hook, quiet };
}

test('without tools, hook, status and stop start zero processes; turn output is model context', async (t) => {
  const f = fixture(t);
  assert.equal(IDLE_MS, 60_000);
  assert.deepEqual(await f.status(), { running: false, endpoints: [] });
  assert.equal(fs.existsSync(f.root), false);
  const submitted = await f.hook('UserPromptSubmit', 'turn-1');
  assert.equal(submitted.code, 0);
  assert.equal(submitted.stderr, '');
  assert.deepEqual(Object.keys(submitted.result), ['hookSpecificOutput']);
  assert.match(submitted.result.hookSpecificOutput.additionalContext, /x64dbg.*x32dbg.*ghidra.*windbg.*ida-mcp/);
  assert.match(submitted.result.hookSpecificOutput.additionalContext, /--args-file.*60 seconds.*secure mode/);
  await f.quiet(f.hook('Stop', 'turn-1'));
  assert.deepEqual((await f.run('stop')).result, { stopped: false });
  assert.deepEqual(await f.status(), { running: false, endpoints: [] });
  assert.deepEqual(f.readEvents(), []);
  assert.equal((await f.start(['status'], { session: '' }).finished).code, 1);
  assert.equal((await f.run('status', '--session', '../unsafe')).code, 1);
});

test('concurrent first use shares one broker, supports two endpoints, and isolates sessions', async (t) => {
  const f = fixture(t, 3500);
  const input = path.join(f.temporary, 'args.json');
  fs.writeFileSync(input, '\uFEFF{"marker":"空 格\\"值"}');
  const requests = [
    f.run('tools', 'ghidra'), f.run('call', 'ghidra', 'fixture', '--args-file', input),
    f.call('ghidra', { value: 2 }).finished, f.call('ida-mcp', { value: 3 }).finished,
  ];
  const [tools, fileResult, ghidra, ida] = await Promise.all(requests);
  for (const response of [tools, fileResult, ghidra, ida]) assert.equal(response.code, 0, response.stderr);
  assert.equal(tools.result.tools[0].name, 'fixture');
  assert.equal(fileResult.result.structuredContent.args.marker, '空 格"值');
  assert.deepEqual([fileResult, ghidra].map((response) => response.result.structuredContent.count).sort(), [1, 2]);
  const active = await f.status();
  assert.deepEqual(active.endpoints.map((endpoint) => endpoint.name).sort(), ['ghidra', 'ida-mcp']);
  assert.equal(f.readEvents().filter((e) => e.event === 'start').length, 2);
  const second = await f.run('call', 'ghidra', 'fixture', '--args-json', '{}', '--session', 'session-b');
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.result.structuredContent.count, 1);
  const other = await f.status('session-b');
  assert.notEqual(active.pid, other.pid);
  assert.equal((await f.run('stop', '--session', 'session-b')).result.stopped, true);
  assert.equal((await f.status()).pid, active.pid);
  const records = fs.readdirSync(f.root).flatMap((dir) => {
    const folder = path.join(f.root, dir);
    return fs.statSync(folder).isDirectory() ? fs.readdirSync(folder).filter((file) => /^\d+\.json$/.test(file))
      .map((file) => JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'))) : [];
  });
  const secret = records.find((record) => record.secret).secret;
  for (const response of [tools, fileResult, ghidra, ida, second]) assert.ok(!(response.stdout + response.stderr).includes(secret));
  assert.ok(!JSON.stringify(active).includes(secret));
});

test('status polling does not defer independent retirement, and a long call is protected', async (t) => {
  const f = fixture(t, 550);
  const finish = path.join(f.temporary, 'finish-call');
  const pending = f.call('ghidra', { waitForFile: finish }).finished;
  t.after(() => fs.existsSync(f.temporary) && fs.writeFileSync(finish, ''));
  const started = await eventually(() => f.readEvents().find((e) => e.event === 'call'), 'long call started');
  assert.equal((await f.call('ida-mcp', {}).finished).code, 0);
  const active = await f.status();
  assert.equal(active.endpoints.find((e) => e.name === 'ghidra').busy, true);
  await eventually(async () => {
    const info = await f.status();
    return info.endpoints.some((e) => e.name === 'ghidra' && e.busy) && info.endpoints.every((e) => e.name !== 'ida-mcp');
  }, 'idle IDA was reaped while the long Ghidra call continued');
  fs.writeFileSync(finish, '');
  assert.equal((await pending).code, 0);
  await eventually(async () => !(await f.status()).running && !alive(active.pid), 'idle broker exited');
  assert.equal(alive(started.pid), false);
  const fresh = await f.call('ghidra', {}).finished;
  assert.equal(fresh.result.structuredContent.count, 1);
  assert.notEqual((await f.status()).pid, active.pid);
});

test('different launcher or runtime identity does not reuse an existing endpoint', async (t) => {
  const f = fixture(t, 5000);
  assert.equal((await f.call('ghidra', {}).finished).code, 0);
  const before = await f.status();
  const after = await f.start(['call', 'ghidra', 'fixture', '--args-json', '{}'], { identity: 'different' }).finished;
  assert.equal(after.code, 0, after.stderr);
  assert.equal(after.result.structuredContent.count, 1);
  assert.notEqual((await f.status()).pid, before.pid);
});

test('missing Python requests Dbg doctor without starting a backend', async (t) => {
  const f = fixture(t, 5000, 15000, 'missing');
  const response = await f.run('tools', 'ghidra');
  assert.equal(response.code, 1);
  assert.equal(response.result.error.data.reason, 'needs_doctor');
  assert.deepEqual(f.readEvents(), []);
  await eventually(async () => !(await f.status()).running, 'broker retired after failed preparation');
});

test('cold runtime preparation runs only the selected doctor recipe through ProcessOwner', async (t) => {
  const f = fixture(t, 5000, 15000, 'cold');
  const response = await f.call('ghidra', {}).finished;
  assert.equal(response.code, 0, response.stderr);
  assert.deepEqual(f.readEvents().filter((event) => event.event === 'doctor').map((event) => event.data.args),
    [['doctor', '--tool', 'ghidra']]);
  assert.deepEqual(f.readEvents().filter((event) => event.event === 'start').map((event) => event.name), ['ghidra']);
});

test('Ghidra preparation cannot mark an old WinDbg backend ready under a new policy', async (t) => {
  const f = fixture(t, 5000, 15000, 'policy-drift');
  const ghidra = await f.run('tools', 'ghidra');
  assert.equal(ghidra.code, 0, ghidra.stderr);
  assert.equal(ghidra.result.tools[0].name, 'fixture');
  const file = path.join(f.temporary, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.tools.windbg.backend, 'legacy');
  const fullDeploymentPolicy = state.auto_windbg_backend;
  assert.equal((await f.run('tools', 'ida-mcp')).code, 0);

  // Older targeted doctor calls may already have written this global value without updating WinDbg.
  state.auto_windbg_backend = 'native';
  fs.writeFileSync(file, JSON.stringify(state));
  const windbg = await f.run('tools', 'windbg');
  assert.equal(windbg.code, 0, windbg.stderr);
  assert.equal(windbg.result.tools[0].name, 'fixture');
  assert.equal(fullDeploymentPolicy, 'legacy', 'single-endpoint doctor leaves the full deployment policy intact');
  assert.deepEqual(f.readEvents().filter((event) => event.event === 'doctor').map((event) => event.data.args),
    [['doctor', '--tool', 'ghidra'], ['doctor', '--tool', 'windbg']]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tools.windbg.backend, 'native');
  const fallback = await f.call('windbg', { fallbackDiagnostic: true, delay: 40 }).finished;
  assert.equal(fallback.code, 0);
  assert.equal(fallback.stderr.trim(), 'Dbg: Official WinDbg proxy could not start. Using the saved legacy cdb/kd compatibility backend.');
  assert.equal(fallback.result.structuredContent.name, 'windbg');
});

test('Stop responds during cold preparation and releases its process tree', async (t) => {
  const f = fixture(t, 5000, 15000, 'blocked');
  const call = f.call('ghidra', {});
  const doctor = await eventually(() => f.readEvents().find((event) => event.event === 'doctor'), 'owned doctor started');
  const pids = [doctor.pid, doctor.data.parent, doctor.data.child];
  assert.ok(pids.every(alive));
  assert.equal((await f.status()).endpoints[0].busy, true);
  assert.deepEqual((await f.run('stop')).result, { stopped: true });
  assert.equal((await call.finished).code, 1);
  await eventually(() => pids.every((pid) => !alive(pid)), 'doctor supervisor, doctor and child were stopped');
  assert.ok(f.readEvents().every((event) => event.event !== 'start'));
});

test('stale Stop does not stop a new turn, while matching lifecycle events clean only their session', async (t) => {
  const f = fixture(t, 5000);
  await f.hook('UserPromptSubmit', 'turn-1');
  const previous = f.call('ghidra', { hold: true, turn: 1 });
  await eventually(() => f.readEvents().find((e) => e.data?.turn === 1), 'the previous turn has a pending call');
  const first = await f.status();
  await f.hook('UserPromptSubmit', 'turn-2');
  await f.quiet(f.hook('Stop', 'turn-1'));
  assert.equal((await previous.finished).code, 1);
  await eventually(() => !alive(first.pid), 'the superseded broker exited before a new call');
  const next = f.call('ghidra', { hold: true, turn: 2 });
  await eventually(() => f.readEvents().find((e) => e.data?.turn === 2), 'the next turn has a pending call');
  const second = await f.status();
  assert.notEqual(second.pid, first.pid);
  await f.quiet(f.hook('Stop', 'turn-1'));
  assert.equal((await f.status()).pid, second.pid);
  assert.equal((await f.run('tools', 'ida-mcp', '--session', 'session-b')).code, 0);
  await f.quiet(f.hook('Interrupt', 'turn-2'));
  assert.equal((await next.finished).code, 1);
  await eventually(async () => !(await f.status()).running, 'matching Interrupt cleaned the broker');
  assert.equal((await f.status('session-b')).running, true);
  const continuation = await f.call('ghidra', {}).finished;
  assert.equal(continuation.code, 0, continuation.stderr);
  assert.equal(continuation.result.structuredContent.count, 1);
  assert.notEqual((await f.status()).pid, first.pid);
  await f.quiet(f.hook('SessionEnd', undefined, 'session-b'));
  await eventually(async () => !(await f.status('session-b')).running, 'SessionEnd cleaned the other broker');
});

test('subagent tools use their own thread and SubagentStop does not stop the parent', async (t) => {
  const f = fixture(t, 5000);
  const submitted = await f.hook('SubagentStart', undefined, 'session-a', 'session-b');
  assert.equal(submitted.result.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.equal(fs.readdirSync(f.root).length, 1, 'only the agent turn metadata was created');
  assert.equal((await f.status('session-b')).running, false);
  assert.equal((await f.call('ghidra', {}).finished).code, 0);
  const parent = await f.status();
  const child = await f.start(['call', 'ghidra', 'fixture', '--args-json', '{}'], { thread: 'session-b' }).finished;
  assert.equal(child.code, 0, child.stderr);
  assert.equal(child.result.structuredContent.count, 1);
  const agent = await f.status('session-b');
  assert.notEqual(agent.pid, parent.pid);
  await f.quiet(f.hook('SubagentStop'));
  assert.equal((await f.status()).pid, parent.pid);
  assert.equal((await f.status('session-b')).pid, agent.pid);
  await f.quiet(f.hook('SubagentStop', undefined, 'session-a', 'session-b'));
  await eventually(async () => !(await f.status('session-b')).running, 'only the agent broker was closed');
  assert.equal((await f.status()).pid, parent.pid);
});

test('SubagentStop fences an already-spawned contender before it claims ownership', async (t) => {
  const f = fixture(t, 5000);
  const gate = path.join(f.temporary, 'claim-gate');
  await f.hook('SubagentStart', undefined, 'session-a', 'session-b');
  const queued = f.start(['tools', 'ghidra'], { thread: 'session-b', claimGate: gate });
  try {
    await eventually(() => fs.existsSync(gate + '.entered'), 'the contender is waiting before claim');
    assert.equal((await f.status('session-b')).running, false);
    await f.quiet(f.hook('SubagentStop', undefined, 'session-a', 'session-b'));
  } finally {
    fs.writeFileSync(gate, '');
  }
  assert.equal((await queued.finished).code, 1);
  await eventually(() => fs.existsSync(gate + '.done'), 'the fenced contender exited without starting a broker');
  assert.equal((await f.status('session-b')).running, false);
  assert.deepEqual(f.readEvents(), []);
});

test('backend errors are visible, callbacks unsupported, and a crashed call is never replayed', async (t) => {
  const f = fixture(t);
  const error = await f.call('ghidra', { error: true }).finished;
  assert.equal(error.code, 1);
  assert.equal(error.result.isError, true);
  const callback = await f.call('ghidra', { callback: true }).finished;
  assert.equal(callback.code, 1);
  assert.equal(callback.result.structuredContent.callback.code, -32601);
  assert.deepEqual(f.readEvents().find((e) => e.event === 'initialize').data, {});
  const failed = await f.call('ghidra', { crash: true }).finished;
  assert.equal(failed.code, 1);
  assert.match(failed.result.error.message, /disconnected/);
  const next = await f.call('ghidra', {}).finished;
  assert.equal(next.code, 0, next.stderr);
  assert.equal(next.result.structuredContent.count, 1);
  assert.equal(f.readEvents().filter((e) => e.event === 'call' && e.data.crash).length, 1);
});

test('client disconnect cancels its backend without stopping a different endpoint', async (t) => {
  const f = fixture(t, 5000);
  assert.equal((await f.run('tools', 'ida-mcp')).code, 0);
  const waiting = f.call('ghidra', { hold: true });
  const invoked = await eventually(() => f.readEvents().find((e) => e.data?.hold), 'the disconnected call was forwarded');
  waiting.child.kill('SIGKILL');
  await waiting.finished;
  await eventually(async () => !alive(invoked.pid) && (await f.status()).endpoints.every((e) => e.name !== 'ghidra'),
    'the disconnected call was reaped');
  assert.deepEqual((await f.status()).endpoints.map((endpoint) => endpoint.name), ['ida-mcp']);
});

test('request timeout closes a stuck backend and reports a nonzero result', async (t) => {
  const f = fixture(t, 5000, 1700);
  const response = await f.call('ghidra', { hold: true }).finished;
  assert.equal(response.code, 1);
  assert.match(response.result.error.message, /timed out/);
  assert.ok(f.readEvents().some((e) => e.event === 'call'));
  await eventually(async () => !(await f.status()).running, 'timed out endpoint closed');
});

test('a killed broker releases the Python owner, backend and grandchild; stale ownership recovers', async (t) => {
  const f = fixture(t, 5000);
  assert.equal((await f.call('ghidra', {}).finished).code, 0);
  const active = await f.status();
  const event = f.readEvents().find((e) => e.event === 'start');
  assert.ok([active.pid, active.endpoints[0].backendPid, event.pid, event.data].every(alive));
  // Test-only crash injection. Production uses authenticated IPC or a retained ChildProcess handle.
  process.kill(active.pid, 'SIGKILL');
  await eventually(() => [active.pid, active.endpoints[0].backendPid, event.pid, event.data].every((pid) => !alive(pid)),
    'the broker, Python owner, backend and grandchild should all exit');
  const next = await f.call('ghidra', {}).finished;
  assert.equal(next.code, 0, next.stderr);
  assert.notEqual((await f.status()).pid, active.pid);
});
