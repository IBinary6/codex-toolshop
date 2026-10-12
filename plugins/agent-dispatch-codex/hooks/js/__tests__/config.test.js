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
process.env.CODEX_HOME = path.join(root, 'codex-home');

const {
  PROJECT_DIR,
  ensureConfigFiles,
  loadDefaults,
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
  assert.equal(Object.hasOwn(project.overrides, 'git_readonly_add'), false);
  assert.equal(Object.hasOwn(project.overrides, 'git_safe_write_add'), false);
  project.modules.prompt_guidance = false;
  project.policy.max_parallel_subagents = 2;
  project.agent_profiles.profiles.dispatch_worker = { model: 'gpt-6.1-sol' };
  project.overrides.prompt_keywords_add = ['my-keyword'];
  project.overrides.prompt_keywords_remove = ['audit'];
  fs.writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`, 'utf8');

  const effective = loadConfig(repo);
  assert.equal(effective.modules.prompt_guidance, false);
  assert.equal(effective.policy.max_parallel_subagents, 2);
  assert.deepEqual(effective.policy.low_cost, loadDefaults().policy.low_cost);
  assert.equal(effective.agent_profiles.profiles.dispatch_worker.model, 'gpt-6.1-sol');
  assert.equal(effective.agent_profiles.profiles.dispatch_worker.sandbox_mode, 'workspace-write');
  assert.ok(effective.whitelist.prompt_keywords.includes('my-keyword'));
  assert.ok(!effective.whitelist.prompt_keywords.includes('audit'), 'a removed default keyword is gone');
  assert.equal(Object.hasOwn(effective.whitelist, 'shell_heads'), false, 'the shell and MCP allow-lists are gone');
  assert.equal(Object.hasOwn(effective.whitelist, 'mcp_prefixes'), false);
  assert.equal(Object.hasOwn(effective.whitelist, 'git_readonly'), false);
  assert.equal(Object.hasOwn(effective.whitelist, 'git_safe_write'), false);

  const merged = mergeConfig(effective, { overrides: { prompt_keywords_add: ['my-keyword'] } });
  assert.equal(merged.whitelist.prompt_keywords.filter((item) => item === 'my-keyword').length, 1);
  // A configuration written by an earlier version may still carry the removed keys; they are ignored, not an error.
  const legacy = mergeConfig(loadDefaults(), { overrides: { shell_heads_add: ['my-tool'], mcp_prefixes_add: ['mcp__x__'] }, modules: { pre_tool_nudge: true } });
  assert.equal(Object.hasOwn(legacy.whitelist, 'shell_heads'), false);

  const lowCostOverride = mergeConfig(loadDefaults(), {
    policy: { low_cost: { enabled: false } },
  });
  assert.deepEqual(lowCostOverride.policy.low_cost, {
    ...loadDefaults().policy.low_cost,
    enabled: false,
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
