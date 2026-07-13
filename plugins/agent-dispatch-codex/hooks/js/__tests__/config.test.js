'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dispatch-codex-config-'));
const data = path.join(root, 'plugin-data');
const repo = path.join(root, 'repo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: repo });

process.env.PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
process.env.PLUGIN_DATA = data;

const {
  PROJECT_DIR,
  ensureConfigFiles,
  loadConfig,
  mergeConfig,
  projectConfigPath,
} = require('../lib/config');

try {
  const paths = ensureConfigFiles(repo);
  assert.ok(fs.existsSync(paths.global));
  assert.ok(fs.existsSync(paths.project));
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false, 'SessionStart must not modify .gitignore');

  const exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  const excludePath = path.isAbsolute(exclude) ? exclude : path.resolve(repo, exclude);
  assert.match(fs.readFileSync(excludePath, 'utf8'), new RegExp(`${PROJECT_DIR.replace('.', '\\.')}\\/`));

  const projectFile = projectConfigPath(repo);
  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  project.modules.prompt_guidance = false;
  project.policy.max_parallel_subagents = 2;
  project.agent_profiles.profiles.dispatch_worker = { model: 'gpt-5.6' };
  project.overrides.shell_heads_add = ['my-tool'];
  project.overrides.shell_heads_remove = ['rm'];
  fs.writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`, 'utf8');

  const effective = loadConfig(repo);
  assert.equal(effective.modules.prompt_guidance, false);
  assert.equal(effective.policy.max_parallel_subagents, 2);
  assert.equal(effective.agent_profiles.profiles.dispatch_worker.model, 'gpt-5.6');
  assert.equal(effective.agent_profiles.profiles.dispatch_worker.sandbox_mode, 'workspace-write');
  assert.ok(effective.whitelist.shell_heads.includes('my-tool'));

  const merged = mergeConfig(effective, { overrides: { shell_heads_add: ['my-tool'] } });
  assert.equal(merged.whitelist.shell_heads.filter((item) => item === 'my-tool').length, 1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
