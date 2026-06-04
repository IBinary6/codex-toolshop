'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const entry = path.join(pluginRoot, 'scripts', 'run-hook.cjs');

function runSession(cwd, codexHome, extraEnv = {}) {
  return spawnSync(process.execPath, [entry, 'session_start'], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: path.join(codexHome, 'plugin-data'),
      CODEMAP_BOOST_DISABLE_BOOTSTRAP: '1',
      CODEMAP_BOOST_DISABLE_BACKGROUND: '1',
      ...extraEnv,
    },
    windowsHide: process.platform === 'win32',
  });
}

function sh(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: process.platform === 'win32',
  });
  assert.strictEqual(result.status, 0, result.stderr);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-agents-'));
try {
  const home = path.join(tmp, 'codex-home');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  sh(['init'], repo);

  const inactiveAgents = path.join(home, 'AGENTS.md');
  fs.mkdirSync(path.dirname(inactiveAgents), { recursive: true });
  fs.writeFileSync(inactiveAgents, [
    'before',
    '<!-- codemap-boost-codex:start -->',
    'old block',
    '<!-- codemap-boost-codex:end -->',
    'after',
    '',
  ].join('\n'), 'utf8');

  const inactive = runSession(repo, home, { CODEMAP_BOOST_DISABLE_GRAPH: '1' });
  assert.strictEqual(inactive.status, 0, inactive.stderr);
  assert.strictEqual(inactive.stdout, '', 'SessionStart without CLI should be silent');
  const untouched = fs.readFileSync(inactiveAgents, 'utf8');
  assert.ok(untouched.includes('old block'), 'SessionStart without CLI should not rewrite AGENTS.md');
  assert.ok(!fs.existsSync(path.join(repo, '.gitignore')), 'SessionStart without CLI should not touch project gitignore');

  const first = runSession(repo, home, { CODEMAP_BOOST_ASSUME_CRG: '1' });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(first.stdout, '', 'SessionStart should be silent');
  assert.strictEqual(first.stderr, '', 'SessionStart should keep stderr silent');

  const agents = path.join(home, 'AGENTS.md');
  assert.ok(fs.existsSync(agents), 'SessionStart creates CODEX_HOME/AGENTS.md');
  const content = fs.readFileSync(agents, 'utf8');
  assert.ok(content.includes('codemap-boost-codex:start'), 'managed block is inserted');
  assert.ok(content.includes('mcp__code_review_graph__get_minimal_context_tool'), 'block names CRG MCP tools');
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'SessionStart must not create old host directories');

  const second = runSession(repo, home, { CODEMAP_BOOST_ASSUME_CRG: '1' });
  assert.strictEqual(second.status, 0, second.stderr);
  const again = fs.readFileSync(agents, 'utf8');
  assert.strictEqual((again.match(/codemap-boost-codex:start/g) || []).length, 1, 'managed block is idempotent');
  assert.ok(fs.existsSync(path.join(repo, '.gitignore')), 'SessionStart creates or updates .gitignore');
  const gitignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.ok(gitignore.includes('.code-review-graph/'), 'gitignore protects CRG output');
  assert.ok(gitignore.includes('graphify-out/'), 'gitignore protects graphify output');

  console.log('agents.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
