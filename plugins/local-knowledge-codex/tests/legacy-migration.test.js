'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { legacyFixture, spawnPythonSync } = require('./python-runtime');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'local_knowledge', 'cli.py');

function migrate(environment, extra = []) {
  const result = spawnPythonSync([cli, 'migrate', ...extra, '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, BUGDB_HOME: '', CLAUDE_HOME: '', LOCAL_KNOWLEDGE_HOME: '', ...environment },
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-knowledge-legacy-'));
try {
  // A database left by Claude Code under ~/.claude/bugdb: one record removed before migration (a gap in the ids),
  // one active, one archived. With no --source and no data directory configured, migrate finds it and copies it to ~/.bugdb.
  const home = path.join(temp, 'neutral-home');
  const legacy = path.join(home, '.claude', 'bugdb', 'bugs.db');
  const common = path.join(home, '.bugdb', 'bugs.db');
  const ids = legacyFixture(legacy, 'add', [
    { category: 'build', context: 'legacy record removed before migration', cause: 'fixture', content: 'fixture', remove: true },
    { category: 'link', context: 'error LNK2001 from legacy shared database', cause: 'missing library', content: 'link the library' },
    { category: 'runtime', context: 'legacy archived access violation', cause: 'lifetime', content: 'repair lifetime', status: 'archived' },
  ]);
  assert.deepEqual(ids, [1, 2, 3]);
  const environment = { HOME: home, USERPROFILE: home };

  const first = migrate(environment);
  assert.equal(path.normalize(first.target), common, 'the default target is the shared ~/.bugdb');
  assert.equal(first.shared, false);
  assert.equal(first.copied, true);
  assert.equal(first.migrated, 2);
  assert.equal(fs.existsSync(legacy), true, 'the source is left alone');
  assert.deepEqual(legacyFixture(common, 'dump'), [[2, 'active'], [3, 'archived']], 'ids and statuses survive');

  // A second run finds the target in place and imports only what is missing: nothing.
  const second = migrate(environment);
  assert.equal(second.copied, false);
  assert.equal(second.migrated, 0);
  assert.deepEqual(legacyFixture(common, 'dump'), [[2, 'active'], [3, 'archived']]);

  // A record added to the source since is imported once, with the existing ones deduplicated.
  legacyFixture(legacy, 'add', [{ category: 'config', context: 'added after the first migration', cause: 'fixture', content: 'fixture' }]);
  assert.equal(migrate(environment).migrated, 1);
  assert.equal(migrate(environment).migrated, 0);
  assert.equal(legacyFixture(common, 'dump').length, 3);

  // Migrating a database onto itself is reported, not performed.
  const same = migrate(environment, ['--source', common]);
  assert.equal(same.shared, true);
  assert.equal(same.migrated, 0);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('legacy-migration.test.js PASS');
