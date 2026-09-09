'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const entry = path.join(pluginRoot, 'scripts', 'run-hook.cjs');
const { AGENTS_BLOCK, BLOCK_START, BLOCK_END, CONTEXT, ensureAgentsBlock } = require('../lib/codemap');

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
  const sessionHint = JSON.parse(first.stdout).hookSpecificOutput;
  assert.strictEqual(sessionHint.hookEventName, 'SessionStart');
  assert.strictEqual(sessionHint.additionalContext, CONTEXT,
    'new or resumed tasks inject the shared three-point guidance');
  assert.strictEqual(first.stderr, '', 'SessionStart should keep stderr silent');

  const agents = path.join(home, 'AGENTS.md');
  assert.ok(fs.existsSync(agents), 'SessionStart creates CODEX_HOME/AGENTS.md');
  const content = fs.readFileSync(agents, 'utf8');
  assert.ok(content.includes('codemap-boost-codex:start'), 'managed block is inserted');
  assert.strictEqual(AGENTS_BLOCK, `${BLOCK_START}\n## CodeMap Boost\n\n${CONTEXT}\n\n${BLOCK_END}\n`,
    'managed block and hook injection share one authority text');
  assert.deepStrictEqual(CONTEXT.split('\n').map((line) => line.slice(0, 2)), ['1.', '2.', '3.'],
    'shared guidance remains exactly three numbered points');
  assert.ok(content.includes('code-review-graph'), 'first point keeps graph-first structural retrieval');
  assert.ok(content.includes('tgrep-search-codex'), 'first point keeps indexed text and file discovery routing');
  assert.ok(content.includes('每个 worktree 使用独立根目录和索引'), 'second point keeps worktree isolation');
  assert.ok(content.includes('读取前 barrier'), 'second point keeps the graph read barrier');
  assert.ok(content.includes('先检查延迟加载与工具发现能力'), 'third point keeps deferred-tool discovery');
  assert.ok(content.includes('文本命中不等于关系，零命中不证明不存在'), 'third point keeps evidence limits');
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'SessionStart must not create old host directories');
  assert.ok(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').includes('.code-review-graph/'), 'SessionStart ignores generated graph output locally');

  const second = runSession(repo, home, { CODEMAP_BOOST_ASSUME_CRG: '1' });
  assert.strictEqual(second.status, 0, second.stderr);
  const again = fs.readFileSync(agents, 'utf8');
  assert.strictEqual((again.match(/codemap-boost-codex:start/g) || []).length, 1, 'managed block is idempotent');
  assert.ok(!fs.existsSync(path.join(repo, '.gitignore')), 'SessionStart does not dirty project .gitignore');

  const prefix = '\ufeffcustom rules  \r\n\r\n';
  const suffix = '\r\n\r\nuser suffix  \r\n';
  fs.writeFileSync(agents, `${prefix}${BLOCK_START}\nold\n${BLOCK_END}${suffix}`);
  assert.strictEqual(ensureAgentsBlock(home), true);
  assert.strictEqual(fs.readFileSync(agents, 'utf8'), prefix + AGENTS_BLOCK.trimEnd() + suffix,
    'managed update preserves all bytes outside the block');

  for (const malformed of [BLOCK_START, BLOCK_END, `${BLOCK_END}\n${BLOCK_START}`,
    `${BLOCK_START}\n${BLOCK_START}\n${BLOCK_END}`, `${BLOCK_START}\n${BLOCK_END}\n${BLOCK_END}`]) {
    const original = `${prefix}${malformed}${suffix}`;
    fs.writeFileSync(agents, original);
    assert.strictEqual(ensureAgentsBlock(home), false, 'ambiguous managed boundaries must be rejected');
    assert.strictEqual(fs.readFileSync(agents, 'utf8'), original, 'invalid markers must not overwrite user rules');
  }

  console.log('agents.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
