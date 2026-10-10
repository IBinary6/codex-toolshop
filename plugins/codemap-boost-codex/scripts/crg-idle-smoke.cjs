'use strict';

// 真实安装入口的回收/恢复验收；默认等待完整10分钟，--idle-ms只用于显式加速烟测。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { client, memoryScript, snapshot, success, checked } = require('./crg-smoke.cjs');

function parseArgs(argv) {
  const args = { pluginRoot: path.resolve(__dirname, '..'), dataDir: '', output: '', idleMs: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[++i];
    assert.ok(value && !value.startsWith('--'), `${flag} 必须指定值`);
    if (flag === '--plugin-root') args.pluginRoot = path.resolve(value);
    else if (flag === '--data-dir') args.dataDir = path.resolve(value);
    else if (flag === '--output') args.output = path.resolve(value);
    else if (flag === '--idle-ms') args.idleMs = Number(value);
    else throw new Error(`未知参数：${flag}`);
  }
  assert.ok(args.dataDir, '必须指定私有运行时目录');
  if (args.idleMs !== undefined) assert.ok(Number.isSafeInteger(args.idleMs) && args.idleMs >= 1000, '加速烟测间隔至少1000ms');
  return args;
}

/** 分别验收未编辑图的向量恢复、编辑后的图刷新，以及显式重新 embedding。 */
async function verifyGraphRecovery(call, fixture, query) {
  const graphQuery = { pattern: 'file_summary', target: 'sample.py', repo_root: fixture };
  const restored = await Promise.all([call('query_graph_tool', graphQuery), call('semantic_search_nodes_tool', query)]);
  assert.match(JSON.stringify(restored[0]), /idle_greeting/);
  assert.match(JSON.stringify(restored[1]), /"search_mode"\s*:\s*"(?:semantic|hybrid)"/, '未编辑图回收后必须恢复真实向量搜索');
  assert.match(JSON.stringify(restored[1]), /idle_greeting/);

  fs.appendFileSync(path.join(fixture, 'sample.py'), '\ndef idle_added_after_reclaim():\n    return "fresh"\n');
  // 先完成图刷新；源码变动会使旧 embeddings 失效，首次搜索允许合法 FTS 回退。
  const freshGraph = await call('query_graph_tool', graphQuery);
  assert.match(JSON.stringify(freshGraph), /idle_added_after_reclaim/);
  const editedSearch = await call('semantic_search_nodes_tool', { ...query, query: 'idle_added_after_reclaim' });
  assert.match(JSON.stringify(editedSearch), /"search_mode"\s*:\s*"(?:fts|semantic|hybrid)"/);
  assert.match(JSON.stringify(editedSearch), /"name"\s*:\s*"idle_added_after_reclaim"/, '编辑后的搜索必须返回新符号，不能只回显 query');
  const embedded = await call('embed_graph_tool', { repo_root: fixture, provider: 'local' });
  assert.match(JSON.stringify(embedded), /"total_embeddings"\s*:\s*[1-9]\d*/);
  const reembeddedSearch = await call('semantic_search_nodes_tool', query);
  assert.match(JSON.stringify(reembeddedSearch), /"search_mode"\s*:\s*"hybrid"/, '编辑后显式 embed 必须恢复 hybrid 搜索');
  assert.match(JSON.stringify(reembeddedSearch), /idle_greeting/);
  return { vectorSearchRestoredBeforeEdit: true, editedGraphFresh: true,
    editedGraphSearchInitiallyFts: /"search_mode"\s*:\s*"fts"/.test(JSON.stringify(editedSearch)), hybridSearchAfterReembed: true };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const proxyModule = require(path.join(args.pluginRoot, 'scripts/lazy-mcp.cjs'));
  assert.equal(proxyModule.DEFAULT_IDLE_TIMEOUT_MS, 600000, '安装包默认必须是10分钟');
  const idleMs = args.idleMs ?? proxyModule.DEFAULT_IDLE_TIMEOUT_MS;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-idle-smoke-'));
  const fixture = path.join(temp, 'repo');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'sample.py'), 'def idle_greeting(name):\n    """Welcome a named visitor."""\n    return "Hello " + name\n\ndef idle_caller():\n    return idle_greeting("guest")\n');
  const report = { pluginRoot: args.pluginRoot, pluginVersion: JSON.parse(fs.readFileSync(path.join(args.pluginRoot, 'package.json'))).version,
    defaultIdleMs: proxyModule.DEFAULT_IDLE_TIMEOUT_MS, exercisedIdleMs: idleMs, accelerated: args.idleMs !== undefined,
    startedAt: new Date().toISOString(), checks: [], lifecycleEvents: [], idleObservations: [] };
  let child, finalError, seenProcesses = new Map();
  const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex-home'), PLUGIN_DATA: args.dataDir,
    CODEMAP_BOOST_DISABLE_RUNTIME_UPDATES: '1', CODEX_TOOLSHOP_DISABLE_PLUGIN_UPDATES: '1' };
  try {
    checked('git', ['init', '-q'], { cwd: fixture });
    checked('git', ['add', 'sample.py'], { cwd: fixture });
    checked('git', ['-c', 'user.name=CodeMap Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'fixture'], { cwd: fixture });
    const memFile = memoryScript(temp);
    const server = path.join(args.pluginRoot, 'scripts/mcp-server.cjs');
    const launchOptions = args.idleMs === undefined ? {} : { idleTimeoutMs: args.idleMs };
    child = spawn(process.execPath, ['-e', 'require(process.argv[1]).runMcpServer(JSON.parse(process.argv[2])).then(code=>process.exitCode=code);', server, JSON.stringify(launchOptions)],
      { cwd: args.pluginRoot, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const rpc = client(child);
    let diagnostics = '';
    child.stderr.on('data', chunk => {
      diagnostics += chunk;
      const lines = diagnostics.split('\n'); diagnostics = lines.pop().slice(-4096);
      for (const line of lines) {
        const match = /CRG idle (retiring|stopped) pid=(\d+)/.exec(line);
        if (match) report.lifecycleEvents.push({ event: match[1], pid: Number(match[2]), at: new Date().toISOString() });
      }
    });
    const sample = () => {
      const value = snapshot(child.pid, memFile);
      for (const p of value.processes || []) seenProcesses.set(p.pid, p.createdAt);
      return value;
    };
    const hook = (name, parameters) => {
      const text = checked(process.execPath, [path.join(args.pluginRoot, 'scripts/run-hook.cjs'), 'pre_graph_tool'],
        { cwd: fixture, env, input: JSON.stringify({ cwd: fixture, tool_name: `mcp__code_review_graph__${name}`, tool_input: parameters }), timeout: 600000 });
      const gate = text.trim() ? JSON.parse(text) : {};
      assert.notEqual(gate.hookSpecificOutput?.permissionDecision, 'deny');
      return gate.hookSpecificOutput?.updatedInput || parameters;
    };
    const call = async (name, parameters) => success(await rpc.request('tools/call', { name, arguments: hook(name, parameters) }), name);
    await rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'codemap-idle-smoke', version: '1' } });
    rpc.notify('notifications/initialized');
    await rpc.request('logging/setLevel', { level: 'warning' });
    const beforeTools = await rpc.request('tools/list');
    await rpc.request('ping');
    report.cold = sample();
    assert.ok(!(report.cold.processes || []).some(p => /python|code-review-graph/i.test(p.name)), '发现不能启动模型');
    const t0 = Date.now();
    const first = await call('query_graph_tool', { pattern: 'file_summary', target: 'sample.py', repo_root: fixture });
    assert.match(JSON.stringify(first), /idle_greeting/);
    const embedded = await call('embed_graph_tool', { repo_root: fixture, provider: 'local' });
    assert.match(JSON.stringify(embedded), /"total_embeddings"\s*:\s*[1-9]\d*/);
    const query = { query: 'welcome a visitor by name', repo_root: fixture, provider: 'local', limit: 3 };
    const semantic = await call('semantic_search_nodes_tool', query);
    assert.match(JSON.stringify(semantic), /"search_mode"\s*:\s*"(?:semantic|hybrid)"/);
    assert.match(JSON.stringify(semantic), /idle_greeting/);
    report.firstUseMs = Date.now() - t0;
    const completedAt = Date.now();
    report.lastWorkCompletedAt = new Date(completedAt).toISOString();
    report.warm = sample();
    const warmModelPids = (report.warm.processes || []).filter(p => p.torchCpuLoaded).map(p => p.pid);
    assert.ok(warmModelPids.length, '真实Windows模型预热必须完成');
    const deadline = completedAt + idleMs + 45000;
    // 纯前端发现每30秒探活，不应延长后端空闲期限；采样按15秒间隔避免诊断自身扰动。
    let lastProgress = completedAt, lastSample = completedAt, reclaimed;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, idleMs)));
      if (Date.now() - lastProgress >= 30000) {
        await rpc.request('ping');
        assert.deepEqual((await rpc.request('tools/list')).tools, beforeTools.tools);
        process.stdout.write(`${JSON.stringify({ phase: 'waiting-idle', elapsedSeconds: Math.round((Date.now() - completedAt) / 1000), expectedIdleSeconds: idleMs / 1000 })}\n`);
        lastProgress = Date.now();
      }
      if (Date.now() - lastSample < Math.min(15000, idleMs)) continue;
      const value = sample();
      lastSample = Date.now();
      report.idleObservations.push({ elapsedMs: lastSample - completedAt,
        heavyPids: (value.processes || []).filter(p => /python|code-review-graph/i.test(p.name)).map(p => p.pid) });
      if (!(value.processes || []).some(p => /python|code-review-graph/i.test(p.name))) { reclaimed = value; break; }
    }
    assert.ok(reclaimed, '截止前重型后端必须回收');
    const retiredAt = report.lifecycleEvents.find(e => e.event === 'retiring');
    assert.ok(retiredAt, '真实后端必须记录空闲回收事件');
    assert.ok(Date.parse(retiredAt.at) - completedAt >= idleMs - 200, '回收发起时间不得早于空闲期限');
    report.idleElapsedMs = Date.now() - completedAt;
    assert.ok(report.idleElapsedMs >= idleMs - 200, '后端不能提前回收');
    report.reclaimed = reclaimed;
    assert.deepEqual((await rpc.request('tools/list')).tools, beforeTools.tools);
    await rpc.request('ping');
    const restartAt = Date.now();
    report.graphRecovery = await verifyGraphRecovery(call, fixture, query);
    const prompts = await rpc.request('prompts/list');
    const prompt = await rpc.request('prompts/get', { name: prompts.prompts[0].name, arguments: {} });
    assert.ok(prompt.messages?.length, '回收后提示模板也能恢复');
    report.recoveryMs = Date.now() - restartAt;
    report.restored = sample();
    const restoredModelPids = (report.restored.processes || []).filter(p => p.torchCpuLoaded).map(p => p.pid);
    assert.equal(restoredModelPids.length, warmModelPids.length, '并发恢复只产生一份模型后端');
    assert.ok(restoredModelPids.every(p => !warmModelPids.includes(p)), '恢复必须创建新的模型进程');
    report.checks.push('installed default 10min', 'cold discovery no model', 'Windows model warmup', 'real graph and embeddings',
      'idle backend tree exit', 'stdio/discovery survive', 'concurrent restore shared backend', 'vector search before edit after restore',
      'edited graph freshness after restore', 'edited graph search before reembed', 'explicit reembed restores hybrid search', 'prompts after restore');
    report.status = 'passed';
  } catch (error) { finalError = error; report.status = 'failed'; report.error = error.message; }
  finally {
    if (child) {
      const stopped = new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
      child.stdin.end();
      let timer;
      try { await Promise.race([stopped, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('EOF cleanup timeout')), 15000); })]); }
      catch (error) {
        finalError ||= error; report.status = 'failed'; report.cleanupError = error.message;
        try { await require(path.join(args.pluginRoot, 'scripts/lazy-mcp.cjs')).killProcessTree(child); }
        catch (killError) { report.cleanupError += `; ${killError.message}`; }
      }
      finally { clearTimeout(timer); }
      if (process.platform === 'win32' && seenProcesses.size) {
        const checker = path.join(temp, 'survivors.ps1');
        const identities = [...seenProcesses].map(([pid, createdAt]) => `@{ pid=${pid}; created='${createdAt}' }`).join(',');
        fs.writeFileSync(checker, `@(${identities}) | ForEach-Object { $p = Get-Process -Id $_.pid -ErrorAction SilentlyContinue; if ($p -and $p.StartTime.ToUniversalTime().ToString('o') -eq $_.created) { $_.pid } } | ConvertTo-Json -Compress\n`);
        try {
          const alive = checked('powershell.exe', ['-NoProfile', '-File', checker]).trim();
          if (alive) { report.cleanupSurvivors = JSON.parse(alive); throw new Error('owned processes survived EOF'); }
          report.cleanupSurvivors = []; report.checks.push('EOF backend tree cleanup');
        } catch (error) { finalError ||= error; report.status = 'failed'; report.cleanupError = error.message; }
      }
    }
    report.completedAt = new Date().toISOString();
    const resolved = fs.realpathSync(temp), relative = path.relative(fs.realpathSync(os.tmpdir()), resolved);
    assert.ok(!path.isAbsolute(relative) && relative.startsWith('codemap-idle-smoke-') && !relative.includes(path.sep));
    if (report.status === 'passed') fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    else report.retainedFixture = resolved;
    if (args.output) { fs.mkdirSync(path.dirname(args.output), { recursive: true }); fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`); }
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, report: args.output, idleMs, firstUseMs: report.firstUseMs, recoveryMs: report.recoveryMs })}\n`);
  if (finalError) throw finalError;
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main, parseArgs, verifyGraphRecovery };
