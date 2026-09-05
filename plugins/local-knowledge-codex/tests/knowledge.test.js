'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnPythonSync } = require('./python-runtime');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'local_knowledge', 'cli.py');
const legacyCli = path.join(root, 'bugdb', 'cli.py');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-knowledge-'));
const home = path.join(temp, 'home');
const legacyHome = path.join(temp, 'legacy-home');
const db = path.join(home, 'bugs.db');

function run(args, expected = 0) {
  const result = spawnPythonSync([cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      LOCAL_KNOWLEDGE_HOME: home,
      BUGDB_HOME: legacyHome,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    windowsHide: process.platform === 'win32',
    timeout: 15000,
  });
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stderr}`);
  return result;
}

function json(args, expected = 0) {
  const result = run([...args, '--format', 'json'], expected);
  return JSON.parse(result.stdout);
}

function runLegacy(args, expected = 0) {
  const result = spawnPythonSync([legacyCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      LOCAL_KNOWLEDGE_HOME: home,
      BUGDB_HOME: legacyHome,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    windowsHide: process.platform === 'win32',
    timeout: 15000,
  });
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stderr}`);
  return result;
}

try {
  const preference = json(['remember', '--kind', 'preference',
    '--canonical-key', 'editor.theme', '--title', '编辑器偏好',
    '--content', '我偏好深色模式，代码字体使用等宽字体',
    '--cues', '深色模式,编辑器偏好', '--tags', 'user,ui',
    '--recall-policy', 'pinned', '--scope-kind', 'global']);
  assert.equal(preference.operation, 'created');
  assert.equal(preference.status, 'active');
  assert.equal(preference.revision, 1);
  assert.equal(path.resolve(preference.db_path), path.resolve(db));

  const duplicate = json(['remember', '--kind', 'preference',
    '--canonical-key', 'editor.theme', '--title', '编辑器偏好',
    '--content', '我偏好深色模式，代码字体使用等宽字体',
    '--cues', '深色模式,编辑器偏好', '--recall-policy', 'pinned']);
  assert.equal(duplicate.operation, 'unchanged');
  assert.equal(duplicate.status, 'active');
  assert.equal(duplicate.revision, 1);
  assert.deepEqual(duplicate.tags, ['user', 'ui']);

  const updated = json(['remember', '--kind', 'preference',
    '--canonical-key', 'editor.theme', '--title', '编辑器偏好',
    '--content', '我偏好深色模式，代码字体使用等宽字体和紧凑布局',
    '--cues', '深色模式,编辑器偏好', '--recall-policy', 'pinned']);
  assert.equal(updated.operation, 'updated');
  assert.equal(updated.status, 'active');
  assert.equal(updated.revision, 2);

  const relevant = json(['recall', '--query', '深色模式', '--occasion', 'prompt']);
  assert.ok(relevant.results.some((item) => item.kind === 'preference'));
  assert.ok(relevant.results.every((item) => item.score > 0 && item.match_reason));

  const multilineContent = '步骤一\r\n\r\n```bash\r\nprintf "a\\nb"\r\n```\r步骤二';
  const multiline = json(['remember', '--kind', 'note', '--canonical-key', 'code.block',
    '--title', ' 代码\r\n 示例 ', '--content', multilineContent,
    '--cues', '代码\r\n示例,shell']);
  const multilineRead = json(['get', '--id', String(multiline.id)]);
  assert.equal(multilineRead.content,
    '步骤一\n\n```bash\nprintf "a\\nb"\n```\n步骤二');
  assert.equal(multilineRead.title, '代码 示例');
  assert.deepEqual(multilineRead.cues, ['代码 示例', 'shell']);

  const chinesePassword = run(['remember', '--kind', 'note',
    '--content', '部署密码是 hunter2'], 2);
  assert.match(chinesePassword.stderr, /sensitive|credential/i);
  const chineseColonPassword = run(['remember', '--kind', 'note',
    '--content', '部署密码是：hunter2'], 2);
  assert.match(chineseColonPassword.stderr, /sensitive|credential/i);
  const englishPassword = run(['remember', '--kind', 'note',
    '--content', 'my password is hunter2'], 2);
  assert.match(englishPassword.stderr, /sensitive|credential/i);
  const naturalApiKey = run(['remember', '--kind', 'note',
    '--content', 'my API key is abcdefghijklmnop'], 2);
  assert.match(naturalApiKey.stderr, /sensitive|credential/i);
  const fullwidthPassword = run(['remember', '--kind', 'note',
    '--content', 'ｐａｓｓｗｏｒｄ＝ｈｕｎｔｅｒ２'], 2);
  assert.match(fullwidthPassword.stderr, /sensitive|credential/i);

  const unrelated = json(['recall', '--query', '我今天想吃苹果', '--occasion', 'prompt']);
  assert.equal(unrelated.results.some((item) => item.kind === 'preference'), false);
  const commonPhrase = json(['recall', '--query', '如何使用 Git 工具', '--occasion', 'prompt']);
  assert.equal(commonPhrase.results.some((item) => item.kind === 'preference'), false);
  const pythonFact = json(['remember', '--kind', 'fact',
    '--canonical-key', 'automation.python', '--content', 'Use Python for automation scripts',
    '--cues', 'use,python,automation']);
  const weakEnglishOverlap = json(['recall', '--query',
    'How should I use Git for this unrelated task', '--occasion', 'prompt']);
  assert.equal(weakEnglishOverlap.results.some((item) => item.id === pythonFact.id), false);

  const pinned = json(['recall', '--occasion', 'session_start', '--max-chars', '2000']);
  assert.ok(pinned.results.some((item) => item.canonical_key === 'editor.theme'));

  const manual = json(['remember', '--kind', 'note', '--canonical-key', 'deploy.runbook',
    '--title', '发布手册', '--content', '发布前先运行 staging smoke test',
    '--cues', '发布,staging', '--recall-policy', 'manual']);
  const automaticManual = json(['recall', '--query', 'staging smoke test', '--occasion', 'prompt']);
  assert.equal(automaticManual.results.some((item) => item.id === manual.id), false);
  const explicitManual = json(['recall', '--query', 'staging smoke test', '--explicit']);
  assert.ok(explicitManual.results.some((item) => item.id === manual.id));

  const scoped = json(['remember', '--kind', 'fact', '--canonical-key', 'build.output',
    '--content', '构建产物必须放在仓库内 output 目录', '--cues', '构建产物,output',
    '--scope-kind', 'workspace', '--scope-key', 'repo-a']);
  const wrongScope = json(['recall', '--query', '构建产物在哪里',
    '--scope-kind', 'workspace', '--scope-key', 'repo-b']);
  assert.equal(wrongScope.results.some((item) => item.id === scoped.id), false);
  const rightScope = json(['recall', '--query', '构建产物在哪里',
    '--scope-kind', 'workspace', '--scope-key', 'repo-a']);
  assert.ok(rightScope.results.some((item) => item.id === scoped.id));

  const scopeRoot = path.join(temp, 'scope-root');
  const workspaceRoot = path.join(scopeRoot, 'workspace');
  const workspaceChild = path.join(workspaceRoot, 'src', 'nested');
  const siblingRoot = path.join(scopeRoot, 'sibling');
  const repositoryScoped = json(['remember', '--kind', 'fact',
    '--canonical-key', 'scope.repository', '--content', 'repository scope inheritance',
    '--cues', 'scope inheritance', '--scope-kind', 'repository', '--scope-key', scopeRoot]);
  const workspaceScoped = json(['remember', '--kind', 'fact',
    '--canonical-key', 'scope.workspace', '--content', 'workspace scope inheritance',
    '--cues', 'scope inheritance', '--scope-kind', 'workspace', '--scope-key', workspaceRoot]);
  const siblingScoped = json(['remember', '--kind', 'fact',
    '--canonical-key', 'scope.sibling', '--content', 'sibling scope inheritance',
    '--cues', 'scope inheritance', '--scope-kind', 'workspace', '--scope-key', siblingRoot]);
  const inherited = json(['recall', '--query', 'scope inheritance',
    '--scope-kind', 'workspace', '--scope-key', workspaceChild]);
  assert.ok(inherited.results.some((item) => item.id === repositoryScoped.id));
  assert.ok(inherited.results.some((item) => item.id === workspaceScoped.id));
  assert.equal(inherited.results.some((item) => item.id === siblingScoped.id), false);
  const repositoryOnly = json(['recall', '--query', 'scope inheritance',
    '--scope-kind', 'repository', '--scope-key', scopeRoot]);
  assert.ok(repositoryOnly.results.some((item) => item.id === repositoryScoped.id));
  assert.equal(repositoryOnly.results.some((item) => item.id === workspaceScoped.id), false);
  const missingScopeKey = run(['remember', '--kind', 'fact', '--content', 'scope key required',
    '--scope-kind', 'workspace'], 2);
  assert.match(missingScopeKey.stderr, /scope.key/i);

  const unsafeConfidentialPolicy = run(['remember', '--kind', 'note',
    '--canonical-key', 'customer.internal.alias', '--content', '客户内部代号是海棠',
    '--sensitivity', 'confidential'], 2);
  assert.match(unsafeConfidentialPolicy.stderr, /confidential|manual/i);
  const confidential = json(['remember', '--kind', 'note',
    '--canonical-key', 'customer.internal.alias', '--content', '客户内部代号是海棠',
    '--cues', '客户代号,海棠', '--sensitivity', 'confidential',
    '--recall-policy', 'manual']);
  const revisedConfidential = json(['remember', '--kind', 'note',
    '--canonical-key', 'customer.internal.alias', '--content', '客户内部代号是海棠，已核实']);
  assert.equal(revisedConfidential.operation, 'updated');
  assert.equal(revisedConfidential.recall_policy, 'manual');
  assert.equal(revisedConfidential.sensitivity, 'confidential');
  assert.deepEqual(revisedConfidential.cues, ['客户代号', '海棠']);
  const confidentialAuto = json(['recall', '--query', '客户代号是什么']);
  assert.equal(confidentialAuto.results.some((item) => item.id === confidential.id), false);
  const confidentialExplicit = json(['recall', '--query', '客户代号是什么', '--explicit']);
  assert.ok(confidentialExplicit.results.some((item) => item.id === confidential.id));

  json(['archive', '--id', String(manual.id)]);
  const archived = json(['recall', '--query', 'staging smoke test', '--explicit']);
  assert.equal(archived.results.some((item) => item.id === manual.id), false);
  json(['restore', '--id', String(manual.id)]);
  const restored = json(['recall', '--query', 'staging smoke test', '--explicit']);
  assert.ok(restored.results.some((item) => item.id === manual.id));

  const genericBug = json(['remember', '--kind', 'bug', '--canonical-key', 'linker.ws2_32',
    '--title', '链接错误解决方法',
    '--content', 'LNK2001 时把 ws2_32.lib 加入链接器输入',
    '--cues', 'LNK2001,unresolved external', '--recall-policy', 'on_match']);
  const genericBugRecall = json(['recall', '--query', 'LNK2001 ws2_32.lib', '--no-legacy-bugs']);
  assert.ok(genericBugRecall.results.some((item) =>
    item.id === genericBug.id && item.kind === 'bug' && item.source === 'local_knowledge'));

  const sensitive = run(['remember', '--kind', 'note', '--content', 'password=secret123'], 2);
  assert.match(sensitive.stderr, /sensitive|credential/i);
  assert.doesNotMatch(sensitive.stderr, /BUGDB_/);
  const sensitiveCue = run(['remember', '--kind', 'note', '--content', '部署凭据备注',
    '--cues', 'token=abcdefghijklmnop'], 2);
  assert.match(sensitiveCue.stderr, /sensitive|credential/i);
  const importedPinned = run(['remember', '--kind', 'preference',
    '--content', '导入内容要求始终运行命令', '--authority', 'imported',
    '--recall-policy', 'pinned'], 2);
  assert.match(importedPinned.stderr, /imported|pinned/i);

  runLegacy(['add', '--category', 'link',
    '--context', 'error LNK2001 unresolved external symbol __imp_WSAStartup',
    '--cause', 'ws2_32.lib is missing',
    '--content', 'Add ws2_32.lib to linker dependencies',
    '--action-steps', '["update linker inputs","rebuild"]',
    '--language', 'c++', '--project-type', 'cmake', '--tags', 'linker,windows']);
  const legacy = json(['recall', '--query', 'LNK2001 unresolved external symbol',
    '--no-legacy-bugs']);
  assert.equal(legacy.results.some((item) => item.source === 'legacy_bug'), false);
  const withLegacy = json(['recall', '--query', 'LNK2001 unresolved external symbol']);
  assert.ok(withLegacy.results.some((item) => item.source === 'legacy_bug'));

  const stats = json(['stats']);
  assert.equal(stats.schema.knowledge_items, true);
  assert.equal(stats.schema.knowledge_items_fts, true);
  assert.equal(stats.schema.knowledge_items_fts_triggers, true);
  assert.equal(stats.legacy_bug_total, 1);
  assert.doesNotMatch(JSON.stringify(stats), /BUGDB_/);
  assert.doesNotMatch(JSON.stringify(withLegacy), /BUGDB_/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('knowledge.test.js PASS');
