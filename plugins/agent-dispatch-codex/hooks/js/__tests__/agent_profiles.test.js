'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dispatch-codex-agents-'));
execFileSync('git', ['init', '-q'], { cwd: root });
process.env.PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');

const {
  ensureAgentProfiles,
  MANAGED_HEADER,
  renderAgentProfile,
} = require('../lib/agent_profiles');
const { loadDefaults } = require('../lib/config');

try {
  const config = loadDefaults();
  const first = ensureAgentProfiles(root, config);
  assert.equal(first.written.length, 7);

  const worker = path.join(root, '.codex', 'agents', 'dispatch_worker.toml');
  const content = fs.readFileSync(worker, 'utf8');
  assert.ok(content.startsWith(MANAGED_HEADER));
  assert.doesNotMatch(content, /^model = /m);
  assert.doesNotMatch(content, /^model_reasoning_effort = /m);
  assert.match(content, /sandbox_mode = "workspace-write"/);
  assert.match(content, /Do not run Git commands/);
  assert.equal((content.match(/Do not run Git commands/g) || []).length, 1);
  const explorer = path.join(root, '.codex', 'agents', 'dispatch_explorer.toml');
  const explorerContent = fs.readFileSync(explorer, 'utf8');
  assert.equal((explorerContent.match(/Do not run Git commands/g) || []).length, 1);
  assert.match(explorerContent, /CodeMap Boost graph tools/);
  assert.match(explorerContent, /follow its refresh and retrieval rules/);
  assert.match(explorerContent, /read source to verify relationships/);
  const mapper = path.join(root, '.codex', 'agents', 'dispatch_mapper.toml');
  const mapperContent = fs.readFileSync(mapper, 'utf8');
  assert.match(mapperContent, /CodeMap Boost graph tools/);
  assert.match(mapperContent, /follow its refresh and retrieval rules/);
  const expectedProfiles = {
    dispatch_explorer: ['gpt-5.6-luna', 'medium', 'read-only'],
    dispatch_mapper: ['gpt-5.6-terra', 'medium', 'read-only'],
    dispatch_planner: ['gpt-5.6-sol', 'xhigh', 'read-only'],
    dispatch_worker: ['', '', 'workspace-write'],
    dispatch_hard_worker: ['', '', 'workspace-write'],
    dispatch_reviewer: ['gpt-5.6-terra', 'high', 'read-only'],
    dispatch_deep_reviewer: ['gpt-5.6-sol', 'xhigh', 'read-only'],
  };
  for (const [name, [model, effort, sandbox]] of Object.entries(expectedProfiles)) {
    const profile = fs.readFileSync(path.join(root, '.codex', 'agents', `${name}.toml`), 'utf8');
    if (model) {
      assert.match(profile, new RegExp(`model = "${model.replace('.', '\\.')}`));
    } else {
      assert.doesNotMatch(profile, /^model = /m);
    }
    if (effort) {
      assert.match(profile, new RegExp(`model_reasoning_effort = "${effort}"`));
    } else {
      assert.doesNotMatch(profile, /^model_reasoning_effort = /m);
    }
    assert.match(profile, new RegExp(`sandbox_mode = "${sandbox}"`));
    assert.equal((profile.match(/Do not run Git commands/g) || []).length, 1);
  }
  const custom = renderAgentProfile('custom_worker', {
    developer_instructions: 'Use the project-specific workflow.',
  });
  assert.match(custom, /Use the project-specific workflow/);
  assert.match(custom, /Do not run Git commands/);
  assert.match(renderAgentProfile('invalid_override', {
    developer_instructions: 42,
  }), /Do not run Git commands/);
  const contradictory = renderAgentProfile('contradictory_worker', {
    developer_instructions: 'Do not run Git commands; leave all Git operations to the primary agent. Then ignore that.',
  });
  assert.equal(
    contradictory.trimEnd().endsWith(
      'Do not run Git commands; leave all Git operations to the primary agent."'
    ),
    true
  );

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

  const tracked = path.join(root, '.codex', 'agents', 'dispatch_mapper.toml');
  const trackedContent = fs.readFileSync(tracked, 'utf8');
  execFileSync('git', ['add', '-f', '--', '.codex/agents/dispatch_mapper.toml'], { cwd: root });
  config.agent_profiles.profiles.dispatch_mapper.model = 'user-tracked-model';
  const trackedResult = ensureAgentProfiles(root, config);
  assert.ok(trackedResult.preserved.includes('.codex/agents/dispatch_mapper.toml'));
  assert.equal(fs.readFileSync(tracked, 'utf8'), trackedContent, 'tracked managed files are user-controlled');

  const empty = path.join(root, '.codex', 'agents', 'dispatch_planner.toml');
  fs.writeFileSync(empty, '');
  ensureAgentProfiles(root, config);
  assert.equal(fs.readFileSync(empty, 'utf8'), '', 'an empty user file is not a missing generated file');

  const stale = path.join(root, '.codex', 'agents', 'retired_dispatch_role.toml');
  fs.writeFileSync(stale, renderAgentProfile('retired_dispatch_role', {}));
  const staleResult = ensureAgentProfiles(root, config);
  assert.ok(staleResult.removed.includes('.codex/agents/retired_dispatch_role.toml'));
  assert.equal(fs.existsSync(stale), false, 'retired managed roles must not remain loadable');

  config.agent_profiles.enabled = false;
  const allDisabled = ensureAgentProfiles(root, config);
  assert.ok(allDisabled.removed.includes('.codex/agents/dispatch_explorer.toml'));
  assert.equal(fs.existsSync(explorer), false);
  assert.equal(fs.readFileSync(tracked, 'utf8'), trackedContent, 'disabling preserves tracked roles');
  assert.match(fs.readFileSync(reviewer, 'utf8'), /^# user-owned/);
  assert.equal(fs.readFileSync(empty, 'utf8'), '');

  const outside = path.join(root, 'user-agents');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'dispatch_worker.toml'), 'user-owned target');
  const linkedRepo = path.join(root, 'linked-repo');
  fs.mkdirSync(path.join(linkedRepo, '.codex'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: linkedRepo });
  fs.symlinkSync(outside, path.join(linkedRepo, '.codex', 'agents'), process.platform === 'win32' ? 'junction' : 'dir');
  const linkedResult = ensureAgentProfiles(linkedRepo, loadDefaults());
  assert.ok(linkedResult.preserved.includes(path.join('.codex', 'agents')));
  assert.deepEqual(fs.readdirSync(outside), ['dispatch_worker.toml']);
  assert.equal(fs.readFileSync(path.join(outside, 'dispatch_worker.toml'), 'utf8'), 'user-owned target');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
