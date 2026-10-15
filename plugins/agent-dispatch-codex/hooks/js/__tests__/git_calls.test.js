'use strict';

const assert = require('assert').strict;
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Count git invocations: the stub must be installed before the modules under test destructure execFileSync.
const calls = [];
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function counted(command, args, ...rest) {
  if (command === 'git') calls.push(args.join(' '));
  return realExecFileSync.call(this, command, args, ...rest);
};

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dispatch-git-'));
process.env.PLUGIN_DATA = path.join(temporary, 'data');
const repo = path.join(temporary, 'repo');
fs.mkdirSync(repo);
realExecFileSync('git', ['init', '-q'], { cwd: repo });

const { ensureConfigFiles, loadConfig, loadDefaults } = require('../lib/config');
const { ensureAgentProfiles } = require('../lib/agent_profiles');
require('./model_fixture.cjs');

try {
  // SessionStart does all three; the number of git calls must not grow with the number of agent profiles.
  const profiles = loadDefaults().agent_profiles.profiles;
  assert.ok(Object.keys(profiles).length >= 3, 'the defaults define several agent profiles');
  ensureConfigFiles(repo);
  const loaded = loadConfig(repo);
  const result = ensureAgentProfiles(repo, loaded);
  assert.ok(result.written.length >= 3, 'profiles were written');
  assert.ok(calls.length <= 5, `expected at most 5 git calls, saw ${calls.length}: ${calls.join(' | ')}`);
  assert.equal(calls.filter((call) => call.startsWith('rev-parse --show-toplevel')).length, 1, 'the repository root is looked up once');
  assert.equal(calls.filter((call) => call.startsWith('ls-files')).length, 1, 'tracked files are listed once for all profiles');

  // The local exclude file lists each generated path once, even when the hook runs again.
  const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  for (const relative of result.written) assert.equal(exclude.split(/\r?\n/).filter((line) => line.trim() === relative).length, 1, relative);
  assert.equal(exclude.split(/\r?\n/).filter((line) => line.trim() === '.agent-dispatch-codex/').length, 1);
  ensureAgentProfiles(repo, loaded);
  ensureConfigFiles(repo);
  assert.equal(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), exclude, 'a second run changes nothing');

  // A profile file that git tracks is left alone.
  const tracked = path.join(repo, result.written[0]);
  fs.writeFileSync(tracked, '# mine\n');
  realExecFileSync('git', ['add', '-f', result.written[0]], { cwd: repo });
  const again = ensureAgentProfiles(repo, loaded);
  assert.ok(again.preserved.includes(result.written[0]), 'a tracked file is preserved');
  assert.equal(fs.readFileSync(tracked, 'utf8'), '# mine\n');
} finally {
  childProcess.execFileSync = realExecFileSync;
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log('git_calls.test.js PASS');
