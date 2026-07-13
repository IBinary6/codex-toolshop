'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dispatch-codex-agents-'));
execFileSync('git', ['init', '-q'], { cwd: root });
process.env.PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');

const { ensureAgentProfiles, MANAGED_HEADER } = require('../lib/agent_profiles');
const { loadDefaults } = require('../lib/config');

try {
  const config = loadDefaults();
  const first = ensureAgentProfiles(root, config);
  assert.equal(first.written.length, 3);

  const worker = path.join(root, '.codex', 'agents', 'dispatch_worker.toml');
  const content = fs.readFileSync(worker, 'utf8');
  assert.ok(content.startsWith(MANAGED_HEADER));
  assert.match(content, /model = "gpt-5\.6-luna"/);
  assert.match(content, /model_reasoning_effort = "medium"/);
  assert.match(content, /sandbox_mode = "workspace-write"/);

  const exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const excludePath = path.isAbsolute(exclude) ? exclude : path.resolve(root, exclude);
  assert.match(fs.readFileSync(excludePath, 'utf8'), /\.codex\/agents\/dispatch_worker\.toml/);

  const second = ensureAgentProfiles(root, config);
  assert.deepEqual(second.written, [], 'unchanged profiles are not rewritten');

  const reviewer = path.join(root, '.codex', 'agents', 'dispatch_reviewer.toml');
  fs.writeFileSync(reviewer, '# user-owned\nname = "dispatch_reviewer"\n', 'utf8');
  const preserved = ensureAgentProfiles(root, config);
  assert.ok(preserved.preserved.includes('.codex/agents/dispatch_reviewer.toml'));
  assert.match(fs.readFileSync(reviewer, 'utf8'), /^# user-owned/);

  config.agent_profiles.profiles.dispatch_worker.enabled = false;
  const disabled = ensureAgentProfiles(root, config);
  assert.ok(disabled.removed.includes('.codex/agents/dispatch_worker.toml'));
  assert.equal(fs.existsSync(worker), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
