'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { prepareCrgForRead } = require('../lib/codemap');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-lazy-hooks-'));
const pluginRoot = path.resolve(__dirname, '../../..');
const oldDisable = process.env.CODEMAP_BOOST_DISABLE_GRAPH;
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(result.status, 0, result.stderr);
}

try {
  delete process.env.CODEMAP_BOOST_DISABLE_GRAPH;
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '--quiet']);
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'function first() {}\n');
  git(repo, ['add', 'tracked.js']);
  git(repo, ['-c', 'user.name=CodeMap Test', '-c', 'user.email=test@example.com',
    '-c', 'core.hooksPath=none', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);

  const preload = path.join(tmp, 'preload.cjs');
  fs.writeFileSync(preload, `
const fs = require('fs');
const root = process.env.CODEMAP_TEST_PLUGIN;
const codemap = require(root + '/hooks/js/lib/codemap');
for (const name of ['isCodeMapEnabled', 'canUseCrg', 'startAutoBootstrap', 'startCrgBuild',
  'startCrgUpdate', 'refreshLinkedWorktreesSync', 'refreshCrgSync', 'prepareCrgForRead']) {
  codemap[name] = () => { fs.appendFileSync(process.env.CODEMAP_TEST_EVENTS, name + '\\n'); return true; };
}
for (const name of ['cleanLegacyCrgHooks', 'cleanLegacyCrgGitHook', 'ensureAgentsBlock', 'ensureGitInfoExclude']) {
  codemap[name] = () => true;
}
codemap.removeLegacyCrgMcp = () => ({ ok: true, changed: false });
require(root + '/hooks/js/lib/plugin-updates').schedulePluginUpdate = () => {
  fs.appendFileSync(process.env.CODEMAP_TEST_EVENTS, 'schedulePluginUpdate\\n');
};
const child = require('child_process');
child.spawn = () => { fs.appendFileSync(process.env.CODEMAP_TEST_EVENTS, 'spawn\\n'); throw Error('unexpected spawn'); };
`);
  const events = path.join(tmp, 'events');
  for (const [name, toolInput] of [
    ['session_start', {}], ['post_tool_use', { command: 'git worktree add ../new-worktree' }],
    ['post_tool_use', { command: 'Set-Content tracked.js changed' }], ['post_tool_use', {}],
  ]) {
    const result = spawnSync(process.execPath,
      ['--require', preload, path.join(pluginRoot, 'hooks/js', `${name}.js`)], {
        cwd: repo, encoding: 'utf8', input: JSON.stringify({ cwd: repo, tool_input: toolInput }),
        env: { ...process.env, CODEMAP_TEST_PLUGIN: pluginRoot, CODEMAP_TEST_EVENTS: events,
          CODEX_HOME: path.join(tmp, 'home'), PLUGIN_DATA: path.join(tmp, 'data') }, windowsHide: true,
      });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stderr, '');
    if (name === 'session_start') assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /code-review-graph/);
    else assert.strictEqual(result.stdout, '');
    assert.ok(!fs.existsSync(events), `${name} must not probe/install/build/spawn or schedule plugin installation`);
  }

  const installs = [];
  const builds = [];
  const options = {
    pluginDataDir: path.join(tmp, 'isolated-runtime'),
    ensureCrg: (runtime) => { installs.push(runtime); return true; },
    runCrg: (args, runOptions) => {
      builds.push({ args, runOptions });
      fs.mkdirSync(path.join(runOptions.cwd, '.code-review-graph'), { recursive: true });
      fs.writeFileSync(path.join(runOptions.cwd, '.code-review-graph', 'graph.db'), `graph-${builds.length}`);
      return { status: 0 };
    },
  };
  assert.strictEqual(prepareCrgForRead(repo, options), true, 'first demand synchronously prepares and builds');
  assert.strictEqual(builds.length, 1);
  assert.strictEqual(builds[0].args[0], 'build');
  assert.strictEqual(installs[0].version, '2.3.9', 'first install matches the bundled MCP catalog version');
  assert.strictEqual(installs[0].expectedVersion, installs[0].version);
  assert.ok(installs[0].runtimeDir.includes(path.join('crg-runtimes', '2.3.9')));
  assert.strictEqual(path.dirname(builds[0].runOptions.crgCommand), path.join(installs[0].runtimeDir,
    process.platform === 'win32' ? 'Scripts' : 'bin'), 'refresh uses the same frozen runtime prepared by ensureCrg');
  assert.ok(installs[0].deadlineMs <= Date.now() + 570000);
  assert.ok(builds[0].runOptions.timeout <= 570000, 'refresh shares the hook preparation budget');
  assert.strictEqual(prepareCrgForRead(repo, options), true);
  assert.strictEqual(builds.length, 1, 'a repeated read reuses the verified graph');
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'function changed() {}\n');
  assert.strictEqual(prepareCrgForRead(repo, options), true);
  assert.strictEqual(builds[1].args[0], 'update', 'tracked edits are detected at demand without forcing a full build');
  assert.strictEqual(prepareCrgForRead(repo, options), true);
  assert.strictEqual(builds.length, 2);

  let clock = 1000;
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'function budgeted() {}\n');
  assert.strictEqual(prepareCrgForRead(repo, { ...options, deadlineMs: 2000, now: () => clock,
    ensureCrg: () => { clock = 1500; return true; },
  }), true);
  assert.strictEqual(builds.at(-1).runOptions.timeout, 500,
    'runtime preparation time is subtracted from the refresh budget');

  const failureDiagnostics = [];
  assert.strictEqual(prepareCrgForRead(repo, { ...options, diagnostics: failureDiagnostics,
    ensureCrg: () => false, runCrg: () => assert.fail('unready runtime must not refresh'),
  }), false);
  assert.strictEqual(failureDiagnostics.at(-1).code, 'runtime_prepare_failed');
  assert.strictEqual(prepareCrgForRead(tmp, { ensureCrg: () => assert.fail('non-Git must not prepare') }), false);
  process.env.CODEMAP_BOOST_DISABLE_GRAPH = '1';
  assert.strictEqual(prepareCrgForRead(repo, { ensureCrg: () => assert.fail('disabled must not prepare') }), false);
  delete process.env.CODEMAP_BOOST_DISABLE_GRAPH;
  assert.strictEqual(prepareCrgForRead(repo, { ...options, deadlineMs: Date.now() - 1,
    ensureCrg: () => assert.fail('exhausted budget must not install'),
  }), false);
  console.log('lazy_hooks.test.js PASS');
} finally {
  if (oldDisable === undefined) delete process.env.CODEMAP_BOOST_DISABLE_GRAPH;
  else process.env.CODEMAP_BOOST_DISABLE_GRAPH = oldDisable;
  fs.rmSync(tmp, { recursive: true, force: true });
}
