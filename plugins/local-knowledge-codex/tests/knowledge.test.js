'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { legacyFixture, spawnPythonSync } = require('./python-runtime');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'local_knowledge', 'cli.py');
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

try {
  const preference = json(['remember', '--kind', 'preference',
    '--canonical-key', 'editor.theme', '--title', '\u7f16\u8f91\u5668\u504f\u597d',
    '--content', '\u6211\u504f\u597d\u6df1\u8272\u6a21\u5f0f\uff0c\u4ee3\u7801\u5b57\u4f53\u4f7f\u7528\u7b49\u5bbd\u5b57\u4f53',
    '--cues', '\u6df1\u8272\u6a21\u5f0f,\u7f16\u8f91\u5668\u504f\u597d', '--tags', 'user,ui',
    '--recall-policy', 'pinned', '--scope-kind', 'global']);
  assert.equal(preference.operation, 'created');
  assert.equal(preference.status, 'active');
  assert.equal(preference.revision, 1);
  assert.equal(path.resolve(preference.db_path), path.resolve(db));

  const duplicate = json(['remember', '--kind', 'preference',
    '--canonical-key', 'editor.theme', '--title', '\u7f16\u8f91\u5668\u504f\u597d',
    '--content', '\u6211\u504f\u597d\u6df1\u8272\u6a21\u5f0f\uff0c\u4ee3\u7801\u5b57\u4f53\u4f7f\u7528\u7b49\u5bbd\u5b57\u4f53',
    '--cues', '\u6df1\u8272\u6a21\u5f0f,\u7f16\u8f91\u5668\u504f\u597d', '--recall-policy', 'pinned']);
  assert.equal(duplicate.operation, 'unchanged');
  assert.equal(duplicate.status, 'active');
  assert.equal(duplicate.revision, 1);
  assert.deepEqual(duplicate.tags, ['user', 'ui']);

  const updated = json(['remember', '--kind', 'preference',
    '--canonical-key', 'editor.theme', '--title', '\u7f16\u8f91\u5668\u504f\u597d',
    '--content', '\u6211\u504f\u597d\u6df1\u8272\u6a21\u5f0f\uff0c\u4ee3\u7801\u5b57\u4f53\u4f7f\u7528\u7b49\u5bbd\u5b57\u4f53\u548c\u7d27\u51d1\u5e03\u5c40',
    '--cues', '\u6df1\u8272\u6a21\u5f0f,\u7f16\u8f91\u5668\u504f\u597d', '--recall-policy', 'pinned']);
  assert.equal(updated.operation, 'updated');
  assert.equal(updated.status, 'active');
  assert.equal(updated.revision, 2);

  const relevant = json(['recall', '--query', '\u6df1\u8272\u6a21\u5f0f', '--occasion', 'prompt']);
  assert.ok(relevant.results.some((item) => item.kind === 'preference'));
  assert.ok(relevant.results.every((item) => item.score > 0 && item.match_reason));

  const multilineContent = '\u6b65\u9aa4\u4e00\r\n\r\n```bash\r\nprintf "a\\nb"\r\n```\r\u6b65\u9aa4\u4e8c';
  const multiline = json(['remember', '--kind', 'note', '--canonical-key', 'code.block',
    '--title', ' \u4ee3\u7801\r\n \u793a\u4f8b ', '--content', multilineContent,
    '--cues', '\u4ee3\u7801\r\n\u793a\u4f8b,shell']);
  const multilineRead = json(['get', '--id', String(multiline.id)]);
  assert.equal(multilineRead.content,
    '\u6b65\u9aa4\u4e00\n\n```bash\nprintf "a\\nb"\n```\n\u6b65\u9aa4\u4e8c');
  assert.equal(multilineRead.title, '\u4ee3\u7801 \u793a\u4f8b');
  assert.deepEqual(multilineRead.cues, ['\u4ee3\u7801 \u793a\u4f8b', 'shell']);

  const chinesePassword = run(['remember', '--kind', 'note',
    '--content', '\u90e8\u7f72\u5bc6\u7801\u662f hunter2'], 2);
  assert.match(chinesePassword.stderr, /sensitive|credential/i);
  const chineseColonPassword = run(['remember', '--kind', 'note',
    '--content', '\u90e8\u7f72\u5bc6\u7801\u662f\uff1ahunter2'], 2);
  assert.match(chineseColonPassword.stderr, /sensitive|credential/i);
  const englishPassword = run(['remember', '--kind', 'note',
    '--content', 'my password is hunter2'], 2);
  assert.match(englishPassword.stderr, /sensitive|credential/i);
  const naturalApiKey = run(['remember', '--kind', 'note',
    '--content', 'my API key is abcdefghijklmnop'], 2);
  assert.match(naturalApiKey.stderr, /sensitive|credential/i);
  const fullwidthPassword = run(['remember', '--kind', 'note',
    '--content', '\uff50\uff41\uff53\uff53\uff57\uff4f\uff52\uff44\uff1d\uff48\uff55\uff4e\uff54\uff45\uff52\uff12'], 2);
  assert.match(fullwidthPassword.stderr, /sensitive|credential/i);

  const unrelated = json(['recall', '--query', '\u6211\u4eca\u5929\u60f3\u5403\u82f9\u679c', '--occasion', 'prompt']);
  assert.equal(unrelated.results.some((item) => item.kind === 'preference'), false);
  const commonPhrase = json(['recall', '--query', '\u5982\u4f55\u4f7f\u7528 Git \u5de5\u5177', '--occasion', 'prompt']);
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
    '--title', '\u53d1\u5e03\u624b\u518c', '--content', '\u53d1\u5e03\u524d\u5148\u8fd0\u884c staging smoke test',
    '--cues', '\u53d1\u5e03,staging', '--recall-policy', 'manual']);
  const automaticManual = json(['recall', '--query', 'staging smoke test', '--occasion', 'prompt']);
  assert.equal(automaticManual.results.some((item) => item.id === manual.id), false);
  const explicitManual = json(['recall', '--query', 'staging smoke test', '--explicit']);
  assert.ok(explicitManual.results.some((item) => item.id === manual.id));

  const scoped = json(['remember', '--kind', 'fact', '--canonical-key', 'build.output',
    '--content', '\u6784\u5efa\u4ea7\u7269\u5fc5\u987b\u653e\u5728\u4ed3\u5e93\u5185 output \u76ee\u5f55', '--cues', '\u6784\u5efa\u4ea7\u7269,output',
    '--scope-kind', 'workspace', '--scope-key', 'repo-a']);
  const wrongScope = json(['recall', '--query', '\u6784\u5efa\u4ea7\u7269\u5728\u54ea\u91cc',
    '--scope-kind', 'workspace', '--scope-key', 'repo-b']);
  assert.equal(wrongScope.results.some((item) => item.id === scoped.id), false);
  const rightScope = json(['recall', '--query', '\u6784\u5efa\u4ea7\u7269\u5728\u54ea\u91cc',
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
    '--canonical-key', 'customer.internal.alias', '--content', '\u5ba2\u6237\u5185\u90e8\u4ee3\u53f7\u662f\u6d77\u68e0',
    '--sensitivity', 'confidential'], 2);
  assert.match(unsafeConfidentialPolicy.stderr, /confidential|manual/i);
  const confidential = json(['remember', '--kind', 'note',
    '--canonical-key', 'customer.internal.alias', '--content', '\u5ba2\u6237\u5185\u90e8\u4ee3\u53f7\u662f\u6d77\u68e0',
    '--cues', '\u5ba2\u6237\u4ee3\u53f7,\u6d77\u68e0', '--sensitivity', 'confidential',
    '--recall-policy', 'manual']);
  const revisedConfidential = json(['remember', '--kind', 'note',
    '--canonical-key', 'customer.internal.alias', '--content', '\u5ba2\u6237\u5185\u90e8\u4ee3\u53f7\u662f\u6d77\u68e0\uff0c\u5df2\u6838\u5b9e']);
  assert.equal(revisedConfidential.operation, 'updated');
  assert.equal(revisedConfidential.recall_policy, 'manual');
  assert.equal(revisedConfidential.sensitivity, 'confidential');
  assert.deepEqual(revisedConfidential.cues, ['\u5ba2\u6237\u4ee3\u53f7', '\u6d77\u68e0']);
  const confidentialAuto = json(['recall', '--query', '\u5ba2\u6237\u4ee3\u53f7\u662f\u4ec0\u4e48']);
  assert.equal(confidentialAuto.results.some((item) => item.id === confidential.id), false);
  const confidentialExplicit = json(['recall', '--query', '\u5ba2\u6237\u4ee3\u53f7\u662f\u4ec0\u4e48', '--explicit']);
  assert.ok(confidentialExplicit.results.some((item) => item.id === confidential.id));

  json(['archive', '--id', String(manual.id)]);
  const archived = json(['recall', '--query', 'staging smoke test', '--explicit']);
  assert.equal(archived.results.some((item) => item.id === manual.id), false);
  json(['restore', '--id', String(manual.id)]);
  const restored = json(['recall', '--query', 'staging smoke test', '--explicit']);
  assert.ok(restored.results.some((item) => item.id === manual.id));

  const genericBug = json(['remember', '--kind', 'bug', '--canonical-key', 'linker.ws2_32',
    '--title', '\u94fe\u63a5\u9519\u8bef\u89e3\u51b3\u65b9\u6cd5',
    '--content', 'LNK2001 \u65f6\u628a ws2_32.lib \u52a0\u5165\u94fe\u63a5\u5668\u8f93\u5165',
    '--cues', 'LNK2001,unresolved external', '--recall-policy', 'on_match']);
  const genericBugRecall = json(['recall', '--query', 'LNK2001 ws2_32.lib', '--no-legacy-bugs']);
  assert.ok(genericBugRecall.results.some((item) =>
    item.id === genericBug.id && item.kind === 'bug' && item.source === 'local_knowledge'));

  const sensitive = run(['remember', '--kind', 'note', '--content', 'password=secret123'], 2);
  assert.match(sensitive.stderr, /sensitive|credential/i);
  assert.doesNotMatch(sensitive.stderr, /BUGDB_/);
  const sensitiveCue = run(['remember', '--kind', 'note', '--content', '\u90e8\u7f72\u51ed\u636e\u5907\u6ce8',
    '--cues', 'token=abcdefghijklmnop'], 2);
  assert.match(sensitiveCue.stderr, /sensitive|credential/i);
  const importedPinned = run(['remember', '--kind', 'preference',
    '--content', '\u5bfc\u5165\u5185\u5bb9\u8981\u6c42\u59cb\u7ec8\u8fd0\u884c\u547d\u4ee4', '--authority', 'imported',
    '--recall-policy', 'pinned'], 2);
  assert.match(importedPinned.stderr, /imported|pinned/i);

  legacyFixture(db, 'add', [{
    category: 'link', context: 'error LNK2001 unresolved external symbol __imp_WSAStartup',
    cause: 'ws2_32.lib is missing', content: 'Add ws2_32.lib to linker dependencies',
    action_steps: ['update linker inputs', 'rebuild'], language: 'c++', project_type: 'cmake', tags: ['linker', 'windows'],
  }]);
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
