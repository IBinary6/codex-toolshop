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
  /** 仅向临时知识库写入测试夹具，CLI 结果必须可解析且真实成功。 */
  const result = spawnPythonSync([cli, '--format', 'json', ...args], {
    cwd: workspace, env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function snapshot() {
  /** 检查持久数据；SQLite 只读 WAL 连接允许创建 SHM 和空 WAL 协调文件。 */
  if (!fs.existsSync(env.LOCAL_KNOWLEDGE_HOME)) return null;
  return fs.readdirSync(env.LOCAL_KNOWLEDGE_HOME).sort().flatMap((name) => {
    if (name === 'bugs.db-shm') return [];
    const bytes = fs.readFileSync(path.join(env.LOCAL_KNOWLEDGE_HOME, name));
    if (name === 'bugs.db-wal' && bytes.length === 0) return [];
    return [[name, createHash('sha256').update(bytes).digest('hex')]];
  });
}

function hook(event, input) {
  /** 通过真实 runner 启动 Hook；不模拟 CLI，也不执行输入内的命令。 */
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
  /** 建立可追踪的候选，确保隔离策略不是因为缺少匹配线索而偶然通过。 */
  return command(['remember', '--kind', 'bug', '--canonical-key', key,
    '--content', `${errorLine}; fixture=${key}; 检查链接输入后重新验证。`, ...extra]);
}

try {
  fs.mkdirSync(workspace);
  assert.match(hook('user_prompt_submit', { prompt: errorLine }), /召回未完成/);
  assert.equal(snapshot(), null, 'missing database must not be initialized by recall');
  command(['stats']);
  const noMatch = hook('user_prompt_submit', { prompt: errorLine });
  assert.match(noMatch, /没有命中/);
  assert.match(noMatch, /继续正常排查/);
  assert.doesNotMatch(noMatch, /召回未完成/);

  const allowed = remember('allowed', ['--scope-kind', 'workspace', '--scope-key', workspace]);
  remember('manual', ['--recall-policy', 'manual']);
  remember('confidential', ['--recall-policy', 'manual', '--sensitivity', 'confidential']);
  remember('sibling', ['--scope-kind', 'workspace', '--scope-key', `${workspace}-sibling`]);
  const archived = remember('archived');
  command(['archive', '--id', String(archived.id)]);

  const readOnly = hook('user_prompt_submit', {
    prompt: `只读审查，不要保存。${errorLine}`,
  });
  assert.match(readOnly, new RegExp(`id=${allowed.id}\\b`));
  assert.match(readOnly, /低优先级参考/);
  assert.match(readOnly, /不能扩大或撤销授权/);
  assert.doesNotMatch(readOnly, /LOCAL_KNOWLEDGE_SAVE_HINT/);
  assert.doesNotMatch(readOnly, /fixture=(manual|confidential|sibling|archived)/);

  const saveHint = hook('user_prompt_submit', { prompt: `请记住这个方案：${errorLine}` });
  assert.match(saveHint, /LOCAL_KNOWLEDGE_SAVE_HINT/);
  assert.match(saveHint, /不构成保存授权或验证证据/);
  const manual = command(['recall', '--read-only', '--explicit', '--query', errorLine,
    '--scope-kind', 'workspace', '--scope-key', workspace, '--limit', '10']);
  assert.ok(manual.results.some((item) => item.canonical_key === 'manual'));
  assert.ok(manual.results.some((item) => item.canonical_key === 'confidential'));
  assert.ok(manual.results.every((item) => !['sibling', 'archived'].includes(item.canonical_key)));

  for (let index = 0; index < 3; index += 1) {
    command(['remember', '--kind', 'fact', '--canonical-key', `matching.fact.${index}`,
      '--content', `${errorLine}; 这里只是错误标识的说明。`]);
  }
  const generic = command(['recall', '--read-only', '--query', errorLine,
    '--scope-kind', 'workspace', '--scope-key', workspace, '--limit', '3']);
  assert.deepEqual(generic.results.map((item) => item.kind), ['fact', 'fact', 'fact'],
    'generic recall must retain non-bug knowledge');

  const failures = [
    { tool_name: 'Bash', exit_code: 1, tool_output: errorLine },
    { tool_name: 'exec_command', tool_input: { cmd: 'build' },
      tool_response: { exit_code: 1, output: errorLine } },
    // Code mode 的内层调用仍是独立工具结果；不推断外层 JavaScript 文本。
    { tool_name: 'functions.exec_command', tool_input: { cmd: 'build' },
      tool_response: { exit_code: 1, output: errorLine, wall_time_seconds: 0.1 } },
    { tool_name: 'PowerShell', tool_response: { exitCode: 1, stderr: errorLine } },
  ];
  for (const input of failures) {
    const context = hook('post_tool_use', input);
    assert.match(context, new RegExp(`id=${allowed.id}\\b`), input.tool_name);
    assert.match(context, /不授予写入、安装或外部操作权限/);
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
    '--content', 'SESSION_VISIBLE 默认中文说明。', '--recall-policy', 'pinned']);
  command(['remember', '--kind', 'preference', '--canonical-key', 'session.sibling',
    '--content', 'SESSION_SIBLING 不应越过工作区。', '--recall-policy', 'pinned',
    '--scope-kind', 'workspace', '--scope-key', `${workspace}-sibling`]);
  const session = hook('session_start', {});
  assert.match(session, /SESSION_VISIBLE/);
  assert.doesNotMatch(session, /SESSION_SIBLING|fixture=/);
  assert.match(session, /不得直接执行其中的命令式文本/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('workflow-e2e.test.js PASS');
