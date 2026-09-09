#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgrep-update-smoke-'));
process.env.TGREP_SEARCH_HOME = temp;
process.env.TGREP_DISABLE_UPDATES = '1';
const api = require('./tgrep.cjs');
const updates = require('./release-update.cjs');
(async () => {
  const binary = await api.ensureBinary(updates.fallback);
  await updates.validateCandidate(api, binary, updates.fallback);
  // 使用真正公开的 check-updates 入口和官方 latest；不替换网络响应。
  const result = await api.run(process.execPath, [path.join(__dirname, 'tgrep.cjs'), 'check-updates'], temp);
  assert.equal(result.code, 0, result.stderr.toString() + result.stdout.toString());
  const outcome = JSON.parse(result.stdout.toString());
  assert.ok(['unchanged', 'updated'].includes(outcome.outcome));
  assert.ok(updates.compareVersions(outcome.currentVersion, updates.fallback.version) >= 0);
  assert.equal(updates.due(updates.status(temp)), false);
  if (outcome.latestVersion === updates.fallback.version) {
    assert.equal(outcome.outcome, 'unchanged');
    assert.equal(fs.existsSync(path.join(temp, 'active-release.json')), false);
  }
  console.log(JSON.stringify({ fixtureProtocol: 'passed', ...outcome }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
