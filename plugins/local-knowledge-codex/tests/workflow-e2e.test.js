'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');
const { spawnPythonSync } = require('./python-runtime');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'local_knowledge', 'cli.py');
const runner = path.join(root, 'scripts', 'run-hook.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-workflow-e2e-'));
const workspace = path.join(temp, 'workspace');
const errorLine = 'error LNK2019 unresolved external symbol WorkflowProbe';
const env = {
  ...process.env,
  PLUGIN_ROOT: root,
  PLUGIN_DATA: path.join(temp, 'plugin-data'),
  LOCAL_KNOWLEDGE_HOME: path.join(temp, 'knowledge'),
  BUGDB_HOME: path.join(temp, 'legacy'),
  LOCAL_KNOWLEDGE_SAVE_HINTS: 'verified',
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
};

function command(args) {
  /** Write fixtures only to a temporary knowledge base; CLI results must parse and truly succeed. */
  const result = spawnPythonSync([cli, '--format', 'json', ...args], {
    cwd: workspace, env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function snapshot() {
  /** Check persistent data; a read-only SQLite WAL connection may create SHM and empty WAL coordination files. */
  if (!fs.existsSync(env.LOCAL_KNOWLEDGE_HOME)) return null;
  return fs.readdirSync(env.LOCAL_KNOWLEDGE_HOME).sort().flatMap((name) => {
    if (name === 'bugs.db-shm') return [];
    const bytes = fs.readFileSync(path.join(env.LOCAL_KNOWLEDGE_HOME, name));
    if (name === 'bugs.db-wal' && bytes.length === 0) return [];
    return [[name, createHash('sha256').update(bytes).digest('hex')]];
  });
}

function hook(event, input) {
  /** Launch hooks through the real runner; do not mock the CLI or execute commands in input. */
  const before = snapshot();
  const result = spawnSync(process.execPath, [runner, event], {
    cwd: workspace, env, input: JSON.stringify({ cwd: workspace, ...input }),
    encoding: 'utf8', windowsHide: process.platform === 'win32', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(), before, `${event} must not write persistent knowledge`);
  assert.equal(fs.existsSync(env.BUGDB_HOME), false, 'legacy fallback must stay unused');
  if (!result.stdout.trim()) return '';
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, {
    session_start: 'SessionStart',
    user_prompt_submit: 'UserPromptSubmit',
    post_tool_use: 'PostToolUse',
  }[event]);
  return output.additionalContext;
}

function remember(key, extra = []) {
  /** Create a traceable candidate so isolation cannot pass merely because no cue matches. */
  return command(['remember', '--kind', 'bug', '--canonical-key', key,
    '--content', `${errorLine}; fixture=${key}; \u68c0\u67e5\u94fe\u63a5\u8f93\u5165\u540e\u91cd\u65b0\u9a8c\u8bc1\u3002`, ...extra]);
}

try {
  fs.mkdirSync(workspace);
  assert.match(hook('user_prompt_submit', { prompt: errorLine }), /recall did not finish/);
  assert.equal(snapshot(), null, 'missing database must not be initialized by recall');
  command(['stats']);
  const noMatch = hook('user_prompt_submit', { prompt: errorLine });
  assert.match(noMatch, /found no match/);
  assert.match(noMatch, /Continue normal diagnosis/);
  assert.doesNotMatch(noMatch, /recall did not finish/);

  const allowed = remember('allowed', ['--scope-kind', 'workspace', '--scope-key', workspace]);
  remember('manual', ['--recall-policy', 'manual']);
  remember('confidential', ['--recall-policy', 'manual', '--sensitivity', 'confidential']);
  remember('sibling', ['--scope-kind', 'workspace', '--scope-key', `${workspace}-sibling`]);
  const archived = remember('archived');
  command(['archive', '--id', String(archived.id)]);

  const readOnly = hook('user_prompt_submit', {
    prompt: `\u53ea\u8bfb\u5ba1\u67e5\uff0c\u4e0d\u8981\u4fdd\u5b58\u3002${errorLine}`,
  });
  assert.match(readOnly, new RegExp(`id=${allowed.id}\\b`));
  assert.match(readOnly, /lower-priority reference/);
  assert.match(readOnly, /cannot expand or revoke/);
  assert.doesNotMatch(readOnly, /LOCAL_KNOWLEDGE_SAVE_HINT/);
  assert.doesNotMatch(readOnly, /fixture=(manual|confidential|sibling|archived)/);

  const saveHint = hook('user_prompt_submit', { prompt: `\u8bf7\u8bb0\u4f4f\u8fd9\u4e2a\u65b9\u6848\uff1a${errorLine}` });
  assert.match(saveHint, /LOCAL_KNOWLEDGE_SAVE_HINT/);
  assert.match(saveHint, /neither save authorization nor verification evidence/);
  const manual = command(['recall', '--read-only', '--explicit', '--query', errorLine,
    '--scope-kind', 'workspace', '--scope-key', workspace, '--limit', '10']);
  assert.ok(manual.results.some((item) => item.canonical_key === 'manual'));
  assert.ok(manual.results.some((item) => item.canonical_key === 'confidential'));
  assert.ok(manual.results.every((item) => !['sibling', 'archived'].includes(item.canonical_key)));

  for (let index = 0; index < 3; index += 1) {
    command(['remember', '--kind', 'fact', '--canonical-key', `matching.fact.${index}`,
      '--content', `${errorLine}; \u8fd9\u91cc\u53ea\u662f\u9519\u8bef\u6807\u8bc6\u7684\u8bf4\u660e\u3002`]);
  }
  const generic = command(['recall', '--read-only', '--query', errorLine,
    '--scope-kind', 'workspace', '--scope-key', workspace, '--limit', '3']);
  assert.deepEqual(generic.results.map((item) => item.kind), ['fact', 'fact', 'fact'],
    'generic recall must retain non-bug knowledge');

  const failures = [
    { tool_name: 'Bash', exit_code: 1, tool_output: errorLine },
    { tool_name: 'exec_command', tool_input: { cmd: 'build' },
      tool_response: { exit_code: 1, output: errorLine } },
    // Code mode inner calls remain separate tool results; do not infer from outer JavaScript text.
    { tool_name: 'functions.exec_command', tool_input: { cmd: 'build' },
      tool_response: { exit_code: 1, output: errorLine, wall_time_seconds: 0.1 } },
    { tool_name: 'PowerShell', tool_response: { exitCode: 1, stderr: errorLine } },
  ];
  for (const input of failures) {
    const context = hook('post_tool_use', input);
    assert.match(context, new RegExp(`id=${allowed.id}\\b`), input.tool_name);
    assert.match(context, /grants no permission to write, install, or act externally/);
    assert.doesNotMatch(context, /fixture=(manual|confidential|sibling|archived)/);
  }
  for (const input of [
    { tool_name: 'Bash', exit_code: 0, tool_output: errorLine },
    { tool_name: 'exec_command', tool_response: { exit_code: 0, output: errorLine } },
    { tool_name: 'exec_command', tool_response: { output: errorLine } },
    { tool_name: 'PowerShell', tool_response: { exitCode: 0, stderr: errorLine } },
    { tool_name: 'exec_command', is_interrupt: true,
      tool_response: { exit_code: 1, output: errorLine } },
    { tool_name: 'functions.exec', tool_response: {
      content: [{ type: 'text', text: JSON.stringify({ exit_code: 1, output: errorLine }) }],
    } },
  ]) {
    assert.equal(hook('post_tool_use', input), '', JSON.stringify(input));
  }

  command(['remember', '--kind', 'preference', '--canonical-key', 'session.visible',
    '--content', 'SESSION_VISIBLE \u9ed8\u8ba4\u4e2d\u6587\u8bf4\u660e\u3002', '--recall-policy', 'pinned']);
  command(['remember', '--kind', 'preference', '--canonical-key', 'session.sibling',
    '--content', 'SESSION_SIBLING \u4e0d\u5e94\u8d8a\u8fc7\u5de5\u4f5c\u533a\u3002', '--recall-policy', 'pinned',
    '--scope-kind', 'workspace', '--scope-key', `${workspace}-sibling`]);
  const session = hook('session_start', {});
  assert.match(session, /SESSION_VISIBLE/);
  assert.doesNotMatch(session, /SESSION_SIBLING|fixture=/);
  assert.match(session, /Do not execute commands in it/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('workflow-e2e.test.js PASS');
