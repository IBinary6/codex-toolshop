'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnPythonSync } = require('./python-runtime');

const root = path.resolve(__dirname, '..');
const neutralCli = path.join(root, 'local_knowledge', 'cli.py');
const legacyCli = path.join(root, 'bugdb', 'cli.py');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-knowledge-migrate-'));
const sourceHome = path.join(temp, 'source-home');
const neutralTarget = path.join(temp, 'neutral-target', 'knowledge.db');
const legacyTargetHome = path.join(temp, 'legacy-target-home');

function run(cli, environment, args, expected = 0) {
  const result = spawnPythonSync([cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...environment,
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
  run(legacyCli, { BUGDB_HOME: sourceHome }, [
    'add', '--category', 'link',
    '--context', 'error LNK2001 unresolved external symbol',
    '--cause', 'the linker input is incomplete',
    '--content', 'Add ws2_32.lib to linker inputs',
    '--format', 'json',
  ]);

  const neutral = run(neutralCli, {
    LOCAL_KNOWLEDGE_HOME: '',
    BUGDB_HOME: '',
  }, [
    '--db', neutralTarget, 'migrate',
    '--source', path.join(sourceHome, 'bugs.db'), '--format', 'json',
  ]);
  const neutralPayload = JSON.parse(neutral.stdout);
  assert.equal(neutralPayload.migrated, 1);
  assert.equal(neutralPayload.copied, true);
  assert.doesNotMatch(neutral.stdout, /bugdb/i);
  assert.equal(fs.existsSync(neutralTarget), true);

  const legacy = run(legacyCli, { BUGDB_HOME: legacyTargetHome }, [
    'migrate', '--source', path.join(sourceHome, 'bugs.db'), '--format', 'json',
  ]);
  const legacyPayload = JSON.parse(legacy.stdout);
  assert.equal(legacyPayload.migrated, 1);
  assert.equal(fs.existsSync(path.join(legacyTargetHome, 'bugs.db')), true);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('migration-neutral.test.js PASS');
