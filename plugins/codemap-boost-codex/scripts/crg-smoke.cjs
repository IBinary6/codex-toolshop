'use strict';

// Verify on-demand startup with real MCP and temporary worktrees; preserve user repositories, global AGENTS, and model settings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const args = { pluginRoot: path.resolve(__dirname, '..'), dataDir: '', output: '', baseline: false, discoveryOnly: false, filter: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--plugin-root') args.pluginRoot = path.resolve(argv[++i]);
    else if (flag === '--data-dir') args.dataDir = path.resolve(argv[++i]);
    else if (flag === '--output') args.output = path.resolve(argv[++i]);
    else if (flag === '--baseline') args.baseline = true;
    else if (flag === '--discovery-only') args.discoveryOnly = true;
    else if (flag === '--filter') args.filter = argv[++i];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  assert.ok(args.dataDir, 'Specify --data-dir to avoid implicitly changing the default user runtime');
  return args;
}

function checked(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', windowsHide: true, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function client(child) {
  let sequence = 0;
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  const notices = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000); });
  child.stdout.setEncoding('utf8');
  const fail = (error) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (error) { fail(new Error(`non-JSON stdout: ${line}`)); continue; }
      if (message.method && message.id !== undefined) {
        // This fixture needs no sampling but still verifies valid responses to bidirectional requests.
        const result = message.method === 'roots/list' ? { roots: [] } : undefined;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(result ? { result } : { error: { code: -32601, message: 'unsupported smoke client method' } }) })}\n`);
      } else if (message.id !== undefined && pending.has(message.id)) {
        const item = pending.get(message.id);
        clearTimeout(item.timer);
        pending.delete(message.id);
        if (message.error) item.reject(new Error(JSON.stringify(message.error)));
        else item.resolve(message.result);
      } else notices.push(message);
    }
  });
  child.once('error', fail);
  child.once('exit', (code, signal) => fail(new Error(`MCP exited ${code}/${signal}: ${stderr}`)));
  return {
    notices,
    request(method, params = {}, timeout = 600000) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, timeout);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params = {}) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
  };
}

function memoryScript(temp) {
  const file = path.join(temp, 'memory.ps1');
  fs.writeFileSync(file, `param([int]$RootPid)
$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($RootPid)
do {
  $added = $false
  foreach ($row in $all) { if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $added = $true } }
} while ($added)
$rows = @(foreach ($row in $all) {
  if ($ids.Contains([int]$row.ProcessId)) {
    $p = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
    if ($p) {
      $torch = $false
      if ($p.ProcessName -eq 'python') { try { $torch = @($p.Modules | Where-Object { $_.ModuleName -eq 'torch_cpu.dll' }).Count -gt 0 } catch {} }
      [pscustomobject]@{ pid=[int]$row.ProcessId; parent=[int]$row.ParentProcessId; name=$row.Name; createdAt=$p.StartTime.ToUniversalTime().ToString('o'); privateBytes=$p.PrivateMemorySize64; workingSetBytes=$p.WorkingSet64; torchCpuLoaded=$torch }
    }
  }
})
[pscustomobject]@{ processes=$rows; privateBytes=($rows | Measure-Object privateBytes -Sum).Sum; workingSetBytes=($rows | Measure-Object workingSetBytes -Sum).Sum } | ConvertTo-Json -Depth 6 -Compress
`, 'utf8');
  return file;
}

function snapshot(pid, file) {
  if (process.platform !== 'win32') return { platform: process.platform, memoryNotMeasured: true };
  return JSON.parse(checked('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, String(pid)], { timeout: 30000 }));
}

function success(result, name) {
  assert.ok(result && !result.isError, `${name}: ${JSON.stringify(result)}`);
  const data = result.structuredContent || (result.content || []).filter((x) => x.type === 'text').map((x) => { try { return JSON.parse(x.text); } catch (_) { return x.text; } });
  const text = JSON.stringify(data);
  assert.doesNotMatch(text, /"(?:status|error)"\s*:\s*"(?:error|failed|timeout)"/, `${name}: ${text}`);
  return data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-real-smoke-'));
  const fixture = path.join(temp, 'fixture');
  const linked = path.join(temp, 'linked');
  const nonGit = path.join(temp, 'non-git');
  fs.mkdirSync(fixture);
  fs.mkdirSync(nonGit);
  const source = path.join(fixture, 'sample.py');
  fs.writeFileSync(source, 'def smoke_greeting(name):\n    """Build a welcome greeting for a named visitor."""\n    return "Hello " + name\n\ndef smoke_caller():\n    return smoke_greeting("visitor")\n');
  checked('git', ['init', '-q'], { cwd: fixture });
  checked('git', ['add', 'sample.py'], { cwd: fixture });
  checked('git', ['-c', 'user.name=CodeMap Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'fixture'], { cwd: fixture });
  checked('git', ['worktree', 'add', '--detach', linked, 'HEAD'], { cwd: fixture });
  const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex-home'), PLUGIN_DATA: args.dataDir, CODEMAP_BOOST_DISABLE_RUNTIME_UPDATES: '1', CODEX_TOOLSHOP_DISABLE_PLUGIN_UPDATES: '1', CRG_TOOLS: args.filter };
  const hook = (name, input) => {
    const result = checked(process.execPath, [path.join(args.pluginRoot, 'scripts', 'run-hook.cjs'), name], { cwd: fixture, env, input: JSON.stringify(input), timeout: 600000 });
    return result.trim() ? JSON.parse(result) : {};
  };
  const report = { mode: args.baseline ? 'baseline' : 'on-demand', pluginRoot: args.pluginRoot, dataDir: args.dataDir, at: new Date().toISOString(), checks: [] };
  let child;
  let activePids = [];
  try {
    const started = Date.now();
    hook('session_start', { cwd: fixture });
    report.sessionAndEditMs = Date.now() - started;
    report.graphBeforeUse = fs.existsSync(path.join(fixture, '.code-review-graph'));
    if (!args.baseline) assert.equal(report.graphBeforeUse, false, 'SessionStart must not build a graph before use');
    const memFile = memoryScript(temp);
    const initializedAt = Date.now();
    child = spawn(process.execPath, [path.join(args.pluginRoot, 'scripts', 'mcp-server.cjs')], { cwd: args.pluginRoot, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const rpc = client(child);
    const init = await rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'codemap-real-smoke', version: '1.0' } });
    rpc.notify('notifications/initialized');
    await rpc.request('logging/setLevel', { level: 'info' });
    const tools = await rpc.request('tools/list');
    const prompts = await rpc.request('prompts/list');
    const resources = await rpc.request('resources/list');
    const templates = await rpc.request('resources/templates/list');
    assert.ok(Array.isArray(resources.resources));
    assert.ok(Array.isArray(templates.resourceTemplates));
    await rpc.request('ping');
    report.discoveryMs = Date.now() - initializedAt;
    report.capabilities = init.capabilities;
    report.toolNames = tools.tools.map((x) => x.name);
    report.promptNames = prompts.prompts.map((x) => x.name);
    assert.ok(report.toolNames.includes('query_graph_tool'));
    assert.equal(report.promptNames.length, 5);
    if (args.filter) assert.deepEqual(report.toolNames.sort(), args.filter.split(',').map((x) => x.trim()).sort());
    report.beforeUse = snapshot(child.pid, memFile);
    if (process.platform === 'win32' && !args.baseline) assert.equal(report.beforeUse.processes.some((x) => /python|code-review-graph/i.test(x.name)), false, 'discovery must not start the CRG backend');
    report.checks.push(args.baseline ? 'baseline session/edit observed' : 'session/edit deferred', 'initialize/logging/tools/prompts/resources/templates/ping', 'discovery process tree');
    if (!args.discoveryOnly) {
      const call = async (name, parameters, cwd = fixture) => {
        const gate = hook('pre_graph_tool', { cwd, tool_name: `mcp__code_review_graph__${name}`, tool_input: parameters });
        const decision = gate.hookSpecificOutput || {};
        assert.notEqual(decision.permissionDecision, 'deny', `${name}: ${decision.permissionDecisionReason}`);
        const first = report.firstUseMs === undefined && !args.baseline;
        return success(await rpc.request('tools/call', { name, arguments: decision.updatedInput || parameters,
          ...(first ? { _meta: { progressToken: 'real-first-call' } } : {}) }), name);
      };
      const firstUse = Date.now();
      const query = await call('query_graph_tool', { pattern: 'file_summary', target: 'sample.py', repo_root: fixture });
      assert.match(JSON.stringify(query), /smoke_greeting/);
      report.firstUseMs = Date.now() - firstUse;
      if (!args.baseline) {
        const progress = rpc.notices.filter((x) => x.method === 'notifications/progress' && x.params.progressToken === 'real-first-call').map((x) => x.params.progress);
        assert.ok(progress.length > 0, 'the real cold call must report progress');
        assert.ok(progress.every((x, i) => Number.isFinite(x) && (i === 0 || x > progress[i - 1])), 'cold progress must increase');
        report.firstCallProgress = progress;
      }
      report.afterUse = snapshot(child.pid, memFile);
      activePids = (report.afterUse.processes || []).map((x) => x.pid);
      if (process.platform === 'win32') assert.ok(report.afterUse.processes.some((x) => x.torchCpuLoaded), 'original Windows main-thread model initialization must run');
      for (const prompt of prompts.prompts) {
        const value = await rpc.request('prompts/get', { name: prompt.name, arguments: {} });
        assert.ok(value.messages && value.messages.length, prompt.name);
      }
      const indexBefore = checked('git', ['ls-files', '--stage'], { cwd: fixture });
      fs.appendFileSync(source, '\ndef smoke_added_later(value):\n    """Normalize a greeting value after editing the file."""\n    return str(value).strip()\n');
      fs.writeFileSync(path.join(fixture, 'untracked.py'), 'def smoke_untracked():\n    return "untracked fixture"\n');
      const updated = await call('query_graph_tool', { pattern: 'file_summary', target: 'sample.py', repo_root: fixture });
      assert.match(JSON.stringify(updated), /smoke_added_later/);
      const untracked = await call('query_graph_tool', { pattern: 'file_summary', target: 'untracked.py', repo_root: fixture });
      assert.match(JSON.stringify(untracked), /smoke_untracked/);
      assert.equal(checked('git', ['ls-files', '--stage'], { cwd: fixture }), indexBefore, 'real Git index must be preserved');
      const otherRoot = await call('query_graph_tool', { pattern: 'file_summary', target: 'sample.py', repo_root: linked }, nonGit);
      assert.match(JSON.stringify(otherRoot), /smoke_greeting/);
      assert.ok(fs.existsSync(path.join(linked, '.code-review-graph')));
      const isolated = await call('query_graph_tool', { pattern: 'file_summary', target: 'sample.py', repo_root: linked });
      assert.doesNotMatch(JSON.stringify(isolated), /"name"\s*:\s*"smoke_added_later"/);
      const rejected = hook('pre_graph_tool', { cwd: nonGit, tool_name: 'mcp__code_review_graph__query_graph_tool', tool_input: {} });
      assert.equal(rejected.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(fs.existsSync(path.join(nonGit, '.code-review-graph')), false);
      const embedded = await call('embed_graph_tool', { repo_root: fixture, provider: 'local' });
      assert.doesNotMatch(JSON.stringify(embedded), /"status"\s*:\s*"(?:unavailable|error)"/);
      const semantic = await call('semantic_search_nodes_tool', { query: 'welcome greeting for a visitor', repo_root: fixture, provider: 'local', limit: 5 });
      assert.match(JSON.stringify(semantic), /smoke_greeting/);
      report.embeddingResult = embedded;
      report.semanticResult = semantic;
      assert.match(JSON.stringify(embedded), /"total_embeddings"\s*:\s*[1-9]\d*/, `local embeddings must be stored: ${JSON.stringify(embedded)}`);
      assert.match(JSON.stringify(semantic), /"search_mode"\s*:\s*"(?:semantic|hybrid)"/, `semantic search must use vectors: ${JSON.stringify(semantic)}`);
      const concurrent = await Promise.all([rpc.request('tools/call', { name: 'list_graph_stats_tool', arguments: { repo_root: fixture } }), rpc.request('tools/call', { name: 'query_graph_tool', arguments: { pattern: 'file_summary', target: 'sample.py', repo_root: fixture } })]);
      concurrent.forEach((x) => success(x, 'concurrent query'));
      const finalMem = snapshot(child.pid, memFile);
      report.afterRepeatedUse = finalMem;
      const mainPython = (report.afterUse.processes || []).filter((x) => x.name === 'python.exe' && x.torchCpuLoaded).map((x) => x.pid);
      assert.deepEqual((finalMem.processes || []).filter((x) => x.name === 'python.exe' && x.torchCpuLoaded).map((x) => x.pid), mainPython, 'reuse the same model backend');
      report.checks.push('real graph first call', 'Windows model prewarm', 'all five prompts', 'edit/untracked freshness and index preservation', 'explicit root and linked-worktree isolation', 'non-Git denial', 'embedding and semantic search', 'concurrent calls and backend reuse');
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    throw error;
  } finally {
    if (child) {
      const stopped = new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
      child.stdin.end();
      let timeout;
      try { await Promise.race([stopped, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('stdin EOF did not stop launcher')), 10000); })]); }
      catch (error) { if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else child.kill(); throw error; }
      finally { clearTimeout(timeout); }
      if (process.platform === 'win32' && activePids.length) {
        const alive = checked('powershell.exe', ['-NoProfile', '-Command', `$ids=@(${activePids.join(',')}); @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }) | ConvertTo-Json -Compress`]);
        assert.equal(alive.trim(), '', `owned backend processes remain after EOF: ${alive}`);
      }
      report.checks.push('stdin EOF cleanup');
    }
    // Delete only smoke-owned directories resolving within the system temporary directory.
    const resolved = fs.realpathSync(temp);
    assert.ok(path.relative(fs.realpathSync(os.tmpdir()), resolved).startsWith('codemap-real-smoke-'));
    fs.rmSync(resolved, { recursive: true, force: true });
    if (args.output) { fs.mkdirSync(path.dirname(args.output), { recursive: true }); fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`); }
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { parseArgs, client, memoryScript, snapshot, success, checked };
