'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = path.join(__dirname, '..', '..', '..');
const entry = path.join(pluginRoot, 'scripts', 'run-hook.cjs');
const {
  AGENTS_BLOCK, BLOCK_START, BLOCK_END, CONTEXT, LEGACY_MCP_CHECKED_MARKER,
  ensureAgentsBlock, removeAgentsBlock, removeLegacyCrgMcpOnce,
} = require('../lib/codemap');

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
  assert.ok(AGENTS_BLOCK.startsWith(`${BLOCK_START}\n## CodeMap Boost\n\n`), 'managed block keeps its heading');
  assert.ok(AGENTS_BLOCK.endsWith(`\n\n${CONTEXT}\n\n${BLOCK_END}\n`),
    'managed block and hook injection share one authority text');
  assert.ok(content.includes('If that plugin is no longer installed, ignore this section'),
    'a block left behind after removal tells the agent to ignore it');
  assert.ok(content.includes('--uninstall'), 'the block names its removal command');
  assert.deepStrictEqual(CONTEXT.split('\n').map((line) => line.slice(0, 2)), ['1.', '2.', '3.'],
    'shared guidance remains exactly three numbered points');
  assert.ok(content.includes('code-review-graph'), 'first point keeps graph-first structural retrieval');
  assert.ok(content.includes('tgrep-search-codex'), 'shared guidance keeps indexed text and file discovery routing');
  assert.ok(content.includes('CLI entry'), 'tgrep readiness is verified through its real CLI entry');
  assert.ok(content.includes('use live rg'), 'standalone installs retain a usable text-search route');
  assert.ok(!CONTEXT.includes('tool-priority'), 'published guidance must not depend on a personal skill');
  assert.ok(content.includes('current tool catalog and deferred discovery'), 'CRG and Serena are discovered from the live tool catalog');
  assert.ok(content.includes('discover code-review-graph and Serena separately'), 'CRG and Serena availability is discovered independently');
  assert.ok(content.includes('real target Git worktree as repo_root'), 'graph calls use the actual target root');
  assert.ok(content.includes('activate and confirm the real target project by absolute path'), 'Serena activates the actual target project');
  assert.ok(content.includes('Neither the session cwd nor the plugin directory is the target project'), 'session and launcher roots cannot substitute for the target root');
  assert.ok(content.includes('unavailable only for now'), 'tool absence is scoped to the current observation');
  assert.ok(content.includes('rediscover on a later turn or natural demand'), 'later natural demand may rediscover tools');
  assert.ok(content.includes('Do not busy-wait or cache permanent absence'), 'guidance forbids busy waiting and permanent negative caches');
  assert.ok(content.includes('Use graph queries for relationships and impact'), 'tools are selected by evidence type');
  assert.ok(content.includes('stop when evidence is sufficient'), 'cooperation does not force redundant round trips');
  assert.ok(content.includes('Graphs apply only to Git worktrees'), 'guidance preserves Git-only graph scope');
  assert.ok(content.includes('pre-read barrier'), 'guidance preserves the graph read barrier');
  assert.ok(content.includes('A text match does not prove a relationship, and zero matches do not prove absence'), 'third point keeps evidence limits');
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

  // Removal restores user text outside the block and never touches ambiguous markers.
  fs.writeFileSync(agents, `${prefix}${BLOCK_START}\nold\n${BLOCK_END}${suffix}`);
  assert.strictEqual(ensureAgentsBlock(home), true);
  assert.strictEqual(removeAgentsBlock(home), true);
  const removed = fs.readFileSync(agents, 'utf8');
  assert.ok(!removed.includes(BLOCK_START) && !removed.includes(BLOCK_END), 'managed block is removed');
  assert.strictEqual(removed, '\ufeffcustom rules  \r\n\r\nuser suffix  \r\n', 'user text and CRLF endings survive removal');
  assert.strictEqual(removeAgentsBlock(home), true, 'removal is idempotent');
  fs.writeFileSync(agents, '');
  assert.strictEqual(ensureAgentsBlock(home), true);
  assert.strictEqual(removeAgentsBlock(home), true);
  assert.ok(!fs.existsSync(agents), 'a file that only held the managed block is deleted');
  fs.writeFileSync(agents, `${BLOCK_START}\n${BLOCK_START}\n${BLOCK_END}`);
  assert.strictEqual(removeAgentsBlock(home), false, 'ambiguous markers block removal');
  assert.ok(!fs.readdirSync(home).some((name) => name.endsWith('.tmp')), 'atomic writes leave no temporary files');

  // Atomic writes keep a symlinked AGENTS.md linked and keep its permissions.
  if (process.platform !== 'win32') {
    const dotfiles = path.join(tmp, 'dotfiles');
    const linkedHome = path.join(tmp, 'linked-home');
    fs.mkdirSync(dotfiles, { recursive: true });
    fs.mkdirSync(linkedHome, { recursive: true });
    const real = path.join(dotfiles, 'AGENTS.md');
    fs.writeFileSync(real, 'my rules\n', { mode: 0o600 });
    fs.symlinkSync(real, path.join(linkedHome, 'AGENTS.md'));
    assert.strictEqual(ensureAgentsBlock(linkedHome), true);
    assert.ok(fs.lstatSync(path.join(linkedHome, 'AGENTS.md')).isSymbolicLink(), 'the symlink survives the update');
    assert.ok(fs.readFileSync(real, 'utf8').startsWith('my rules\n') && fs.readFileSync(real, 'utf8').includes(BLOCK_START));
    assert.strictEqual(fs.statSync(real).mode & 0o777, 0o600, 'permissions are preserved');
    assert.strictEqual(removeAgentsBlock(linkedHome), true);
    assert.strictEqual(fs.readFileSync(real, 'utf8'), 'my rules\n', 'removal restores the original content through the link');
    assert.ok(fs.lstatSync(path.join(linkedHome, 'AGENTS.md')).isSymbolicLink());
    assert.ok(!fs.readdirSync(dotfiles).some((name) => name.endsWith('.tmp')));
  }

  // The legacy MCP migration runs until a real CLI check succeeds, then never again; a skipped check is
  // retried at most once a day.
  const previousData = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = path.join(tmp, 'once-data');
  try {
    let calls = 0;
    const skipped = () => { calls += 1; return { ok: true, changed: false, skipped: true }; };
    const checked = () => { calls += 1; return { ok: true, changed: false }; };
    const failed = () => { calls += 1; return { ok: false, diagnostic: 'x' }; };
    const marker = path.join(process.env.PLUGIN_DATA, LEGACY_MCP_CHECKED_MARKER);
    const hour = 60 * 60 * 1000;
    let clock = Date.parse('2026-01-01T00:00:00Z');

    removeLegacyCrgMcpOnce({ removeLegacyCrgMcp: failed, now: () => clock });
    removeLegacyCrgMcpOnce({ removeLegacyCrgMcp: failed, now: () => clock });
    assert.strictEqual(calls, 2, 'a failed removal is retried every time');
    assert.ok(!fs.existsSync(marker), 'a failed removal leaves no marker');

    removeLegacyCrgMcpOnce({ removeLegacyCrgMcp: skipped, now: () => clock });
    assert.strictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).status, 'skipped');
    clock += hour;
    const withinDay = removeLegacyCrgMcpOnce({ removeLegacyCrgMcp: skipped, now: () => clock });
    assert.strictEqual(calls, 3, 'a skipped check is not repeated within a day');
    assert.strictEqual(withinDay.cached, true);
    clock += 24 * hour;
    removeLegacyCrgMcpOnce({ removeLegacyCrgMcp: checked, now: () => clock });
    assert.strictEqual(calls, 4, 'a skipped check is retried after a day');
    assert.strictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).status, 'checked');

    clock += 1000 * hour;
    const cached = removeLegacyCrgMcpOnce({ removeLegacyCrgMcp: checked, now: () => clock });
    assert.strictEqual(calls, 4, 'a completed check is never repeated');
    assert.strictEqual(cached.ok, true);

    fs.writeFileSync(marker, '1'); // marker format written by the first release of this feature
    removeLegacyCrgMcpOnce({ removeLegacyCrgMcp: checked, now: () => clock });
    assert.strictEqual(calls, 5, 'an unrecognized marker triggers one fresh check');
    assert.strictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).status, 'checked');
  } finally {
    if (previousData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = previousData;
  }

  console.log('agents.test.js PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
