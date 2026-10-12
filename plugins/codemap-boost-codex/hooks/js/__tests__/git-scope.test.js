'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const hooksDir = path.join(pluginRoot, 'hooks', 'js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-git-scope-')));
const gitEnv = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete gitEnv[key];

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd, env: gitEnv, encoding: 'utf8', windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
}

function assertSameDirectory(actual, expected, message = 'Git resolves the expected directory') {
  // Windows 8.3 short paths and full paths may refer to the same directory; compare filesystem identity.
  const actualStat = fs.statSync(actual, { bigint: true });
  const expectedStat = fs.statSync(expected, { bigint: true });
  assert.ok(actualStat.isDirectory() && expectedStat.isDirectory(), message);
  assert.strictEqual(actualStat.dev, expectedStat.dev, message);
  assert.strictEqual(actualStat.ino, expectedStat.ino, message);
}

try {
  const repo = path.join(tmp, 'repo');
  const nested = path.join(repo, 'src', 'nested');
  const linked = path.join(tmp, 'linked worktree');
  const linkedNested = path.join(linked, 'src', 'nested');
  const plain = path.join(tmp, 'plain');
  const fakeDirectory = path.join(tmp, 'fake-directory');
  const brokenFile = path.join(tmp, 'broken-file');
  const emptyHooks = path.join(tmp, 'empty-hooks');
  for (const dir of [nested, plain, fakeDirectory, brokenFile, emptyHooks]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(fakeDirectory, '.git'));
  fs.writeFileSync(path.join(brokenFile, '.git'), 'gitdir: ../missing-git-directory\n');
  git(repo, ['init', '--quiet']);
  git(repo, ['-c', 'user.name=CodeMap Test', '-c', 'user.email=test@example.com',
    '-c', `core.hooksPath=${emptyHooks}`, '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--allow-empty', '-m', 'test fixture']);
  git(repo, ['-c', `core.hooksPath=${emptyHooks}`, 'worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);
  fs.mkdirSync(linkedNested, { recursive: true });
  assert.ok(fs.statSync(path.join(linked, '.git')).isFile(), 'fixture is a linked worktree with a .git file');

  // Use real Git for root resolution; stubs isolate only CRG, installation, and global-configuration side effects.
  const preload = path.join(tmp, 'scope-preload.cjs');
  fs.writeFileSync(preload, `
'use strict';
const fs = require('fs');
const codemap = require(process.env.CODEMAP_SCOPE_LIBRARY);
for (const name of ['isCodeMapEnabled', 'canUseCrg', 'refreshCrgSync', 'prepareCrgForRead',
  'removeLegacyCrgMcp', 'cleanLegacyCrgHooks', 'cleanLegacyCrgGitHook',
  'ensureAgentsBlock', 'ensureGitInfoExclude', 'readBootstrapFailure']) {
  codemap[name] = (...args) => {
    fs.appendFileSync(process.env.CODEMAP_SCOPE_EVENTS, JSON.stringify({ name, args }) + '\\n');
    if (name === 'removeLegacyCrgMcp') return { ok: true, changed: false };
    if (name === 'readBootstrapFailure') return '';
    return true;
  };
}
require(process.env.CODEMAP_SCOPE_UPDATES).schedulePluginUpdate = () => {};
`);

  let invocation = 0;
  function invoke(name, cwd, extra = {}, options = {}) {
    invocation += 1;
    const data = options.sharedData || path.join(tmp, `data-${invocation}`);
    const eventFile = path.join(tmp, `events-${invocation}.jsonl`);
    const env = {
      ...gitEnv,
      CODEX_HOME: path.join(tmp, 'codex-home'),
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: data,
      CODEMAP_BOOST_DISABLE_BACKGROUND: '1',
      CODEMAP_SCOPE_LIBRARY: path.join(hooksDir, 'lib', 'codemap.js'),
      CODEMAP_SCOPE_UPDATES: path.join(hooksDir, 'lib', 'plugin-updates.js'),
      CODEMAP_SCOPE_EVENTS: eventFile,
    };
    delete env.CODEMAP_BOOST_DISABLE_GRAPH;
    if (options.disabled) env.CODEMAP_BOOST_DISABLE_GRAPH = '1';
    const args = options.runner
      ? [path.join(pluginRoot, 'scripts', 'run-hook.cjs'), name]
      : ['--require', preload, path.join(hooksDir, `${name}.js`)];
    const result = spawnSync(process.execPath, args, {
      cwd: options.processCwd || cwd,
      env,
      input: JSON.stringify({ cwd, session_id: 'same-session', turn_id: 'same-turn', ...extra }),
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stderr, '', `${name} stderr stays silent`);
    const output = result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
    const events = fs.existsSync(eventFile)
      ? fs.readFileSync(eventFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { output, events, data };
  }

  const search = { tool_name: 'Bash', tool_input: { command: 'rg Auth src' } };
  const graph = { tool_name: 'mcp__code_review_graph__query_graph_tool', tool_input: { pattern: 'callers_of', target: 'Auth' } };
  const nudges = [
    ['session_start', {}],
    ['user_prompt_submit', { prompt: '\u67e5\u627e Auth \u7684\u8c03\u7528\u5173\u7cfb' }],
    ['subagent_start', { subagent_type: 'explorer' }],
    ['pre_code_search', search],
  ];

  for (const nonRepo of [plain, fakeDirectory, brokenFile]) {
    for (const [name, payload] of nudges) {
      const result = invoke(name, nonRepo, payload);
      const expectsGuidance = name === 'session_start'
        || name === 'user_prompt_submit'
        || name === 'subagent_start';
      if (expectsGuidance) {
        assert.match(result.output.additionalContext, /code-review-graph/,
          `${name} gives lightweight retrieval guidance outside Git`);
      } else {
        assert.strictEqual(result.output, null, `${name} ignores non-Git code searches`);
      }
      assert.deepStrictEqual(result.events, [], 'non-Git hooks do not probe CRG or mutate configuration');
      assert.ok(!fs.existsSync(result.data), 'non-Git hooks do not create plugin state');
    }
    const barrier = invoke('pre_graph_tool', nonRepo, graph);
    assert.strictEqual(barrier.output.permissionDecision, 'deny');
    assert.match(barrier.output.permissionDecisionReason, /not inside a Git working tree/);
    assert.deepStrictEqual(barrier.events, [], 'invalid graph targets are rejected before runtime probes');
    assert.ok(!fs.existsSync(barrier.data));
    assert.ok(!fs.existsSync(path.join(nonRepo, '.code-review-graph')));
  }

  for (const [name, payload] of nudges.slice(0, 3)) {
    const disabledNudge = invoke(name, plain, payload, { disabled: true });
    assert.strictEqual(disabledNudge.output, null, `${name} stays silent when graph behavior is explicitly disabled`);
    assert.deepStrictEqual(disabledNudge.events, [], 'explicit disable avoids graph probes outside Git');
    assert.ok(!fs.existsSync(disabledNudge.data), 'explicit disable does not create plugin state outside Git');
  }

  // The real launcher must not precreate plugin state outside Git.
  for (const [name, payload] of nudges) {
    const result = invoke(name, plain, payload, { runner: true });
    const expectsGuidance = name === 'session_start'
      || name === 'user_prompt_submit'
      || name === 'subagent_start';
    if (expectsGuidance) assert.match(result.output.additionalContext, /code-review-graph/);
    else assert.strictEqual(result.output, null);
    assert.ok(!fs.existsSync(result.data), 'launcher does not pre-create state outside Git');
  }
  const launcherBarrier = invoke('pre_graph_tool', plain, graph, { runner: true });
  assert.strictEqual(launcherBarrier.output.permissionDecision, 'deny', 'launcher preserves the non-Git graph denial');
  assert.ok(!fs.existsSync(launcherBarrier.data));

  for (const [cwd, expectedRoot] of [[nested, repo], [linkedNested, linked]]) {
    for (const [name, payload] of nudges) {
      const result = invoke(name, cwd, payload);
      assert.ok(result.output.additionalContext, `${name} recognizes a Git parent of ${cwd}`);
      assert.ok(!result.events.some((event) => ['canUseCrg',
        'refreshCrgSync', 'prepareCrgForRead'].includes(event.name)),
      'session and reminders never probe or refresh before a graph call');
    }
    const implicit = invoke('pre_graph_tool', cwd, graph);
    assert.strictEqual(implicit.output.permissionDecision, 'allow');
    assertSameDirectory(implicit.output.updatedInput.repo_root, expectedRoot);
    assertSameDirectory(implicit.events.find((event) => event.name === 'prepareCrgForRead').args[0], expectedRoot);
  }

  const explicit = invoke('pre_graph_tool', nested, {
    ...graph, tool_input: { ...graph.tool_input, repo_root: linkedNested },
  });
  assert.strictEqual(explicit.output.permissionDecision, 'allow');
  assertSameDirectory(explicit.output.updatedInput.repo_root, linked,
    'explicit worktree subdirectory resolves to its own root, not the current checkout');
  assertSameDirectory(explicit.events.find((event) => event.name === 'prepareCrgForRead').args[0], linked);

  const fromNonGit = invoke('pre_graph_tool', plain, {
    ...graph, tool_input: { ...graph.tool_input, repo_root: nested },
  });
  assert.strictEqual(fromNonGit.output.permissionDecision, 'allow', 'explicit Git targets remain usable from a non-Git task');
  assertSameDirectory(fromNonGit.output.updatedInput.repo_root, repo);

  const invalidExplicit = invoke('pre_graph_tool', nested, {
    ...graph, tool_input: { ...graph.tool_input, repo_root: plain },
  });
  assert.strictEqual(invalidExplicit.output.permissionDecision, 'deny', 'invalid explicit target must not fall back to the current Git root');
  assert.deepStrictEqual(invalidExplicit.events, []);

  const disabled = invoke('pre_graph_tool', nested, graph, { disabled: true });
  assert.strictEqual(disabled.output.permissionDecision, 'deny');
  assert.match(disabled.output.permissionDecisionReason, /explicitly disabled/);
  assert.deepStrictEqual(disabled.events, [], 'disabled graph calls do not refresh or bootstrap');

  for (const disabledGraph of [false, true]) {
    const registry = invoke('pre_graph_tool', plain, {
      tool_name: 'mcp__code_review_graph__list_repos_tool', tool_input: {},
    }, { disabled: disabledGraph });
    assert.strictEqual(registry.output, null, 'registry operations do not require the task to be inside Git');
    assert.deepStrictEqual(registry.events, []);
    assert.ok(!fs.existsSync(registry.data));
  }

  const sharedData = path.join(tmp, 'shared-reminders');
  assert.ok(invoke('pre_code_search', nested, search, { sharedData }).output);
  assert.strictEqual(invoke('pre_code_search', nested, search, { sharedData }).output, null);
  assert.ok(invoke('pre_code_search', linkedNested, search, { sharedData }).output,
    'linked worktree reminder is independent even with the same session and turn identifiers');
  assert.strictEqual(invoke('pre_code_search', linkedNested, search, { sharedData }).output, null);
  assert.ok(!fs.existsSync(path.join(repo, '.code-review-graph')));
  assert.ok(!fs.existsSync(path.join(linked, '.code-review-graph')));
  assert.ok(!fs.existsSync(path.join(tmp, 'codex-home')), 'fixtures never mutate host configuration');

  console.log('git-scope.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
