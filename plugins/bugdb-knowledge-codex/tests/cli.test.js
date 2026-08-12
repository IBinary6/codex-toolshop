'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bugdb', 'cli.py');
const python = process.env.BUGDB_TEST_PYTHON || 'python';

function run(home, args, expected = 0) {
  const result = spawnSync(python, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, BUGDB_HOME: home },
    windowsHide: process.platform === 'win32',
    timeout: 15000,
  });
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stderr}`);
  return result;
}

function json(home, args) {
  return JSON.parse(run(home, [...args, '--format', 'json']).stdout);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bugdb-codex-cli-'));
const source = path.join(temp, 'source');
const target = path.join(temp, 'target');
const target2 = path.join(temp, 'target2');
const exportFile = path.join(temp, 'export.json');
try {
  const first = json(source, ['add', '--category', 'link',
    '--context', 'error LNK2001 unresolved external symbol __imp_WSAStartup',
    '--cause', 'ws2_32.lib is missing',
    '--content', 'Add ws2_32.lib to linker dependencies',
    '--action-steps', '["update linker inputs","rebuild"]',
    '--language', 'c++', '--project-type', 'cmake', '--tags', 'linker,windows']);
  assert.ok(first.id);
  const id = first.id;
  assert.equal(json(source, ['get', '--id', String(id)]).content, first.content);
  assert.equal(json(source, ['search', '--query', 'LNK2001 unresolved external symbol']).results[0].id, id);
  assert.equal(json(source, ['find-similar', '--pattern', 'LNK2001 unresolved external symbol']).results[0].id, id);
  assert.equal(json(source, ['update', '--id', String(id), '--content', 'Link ws2_32.lib', '--tags', 'linker']).content, 'Link ws2_32.lib');
  assert.equal(json(source, ['feedback', '--id', String(id), '--result', 'success']).usage_count, 1);
  assert.equal(json(source, ['deprecate', '--id', String(id), '--reason', 'use newer build config']).status, 'deprecated');
  assert.equal(json(source, ['search', '--query', 'LNK2001', '--include-deprecated']).results[0].status, 'deprecated');

  const practice = json(source, ['add', '--entry-kind', 'practice', '--category', 'practice',
    '--context', 'formatting', '--cause', 'readability', '--content', 'Use clear names']);
  assert.equal(json(source, ['obsolete', '--id', String(practice.id), '--reason', 'superseded']).status, 'obsolete');

  const removable = json(source, ['add', '--category', 'build', '--context', 'temporary build failure',
    '--cause', 'test fixture', '--content', 'remove fixture']);
  assert.equal(json(source, ['delete', '--id', String(removable.id)]).hard, false);
  assert.equal(json(source, ['restore', '--id', String(removable.id)]).status, 'active');
  assert.equal(json(source, ['delete', '--id', String(removable.id), '--hard']).hard, true);

  const stats = json(source, ['stats']);
  assert.equal(stats.total, 2);
  const normalized = json(source, ['normalize', '--input', 'C:/work/main.cpp(42): error LNK2001']);
  assert.match(normalized.keywords, /LNK2001/);

  const exported = json(source, ['export', '--output', exportFile]);
  assert.equal(exported.exported, 2);
  assert.equal(json(target, ['import', '--input', exportFile, '--deduplicate']).imported, 2);
  assert.equal(json(target, ['list', '--status', 'all']).results.length, 2);
  assert.equal(json(target2, ['migrate', '--source', path.join(source, 'bugs.db')]).migrated, 2);
  assert.equal(json(target2, ['stats']).total, 2);

  const shared = json(target2, ['migrate', '--source', path.join(target2, 'bugs.db')]);
  assert.equal(shared.shared, true);
  assert.match(json(target2, ['config', 'path']).db_path, /bugs\.db/);
  json(target2, ['config', 'init']);
  json(target2, ['config', 'set', 'example', 'value']);
  assert.equal(json(target2, ['config', 'get', 'example']).example, 'value');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('cli.test.js PASS');
