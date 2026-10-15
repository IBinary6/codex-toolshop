'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const pluginRoot = path.resolve(__dirname, '..', '..', '..');
const runner = path.join(pluginRoot, 'scripts', 'run-hook.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dispatch-codex-hooks-'));
const repo = path.join(temp, 'repo');
const data = path.join(temp, 'data');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: repo });

function run(hook, input) {
  const result = spawnSync(process.execPath, [runner, hook], {
    cwd: repo,
    env: { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: data, CODEX_HOME: path.join(temp, 'codex-home') },
    input: JSON.stringify({ cwd: repo, session_id: 's-1', turn_id: 't-1', ...input }),
    encoding: 'utf8',
    windowsHide: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function parse(output) {
  assert.ok(output, 'expected hook JSON output');
  return JSON.parse(output);
}

try {
  const session = parse(run('session_start', { hook_event_name: 'SessionStart', source: 'startup' }));
  assert.equal(session.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(session.hookSpecificOutput.additionalContext, /primary Codex agent/);
  assert.match(session.hookSpecificOutput.additionalContext, /ordinary single-command Git CLI quiet/);
  assert.match(session.hookSpecificOutput.additionalContext, /complete local commit preparation/);
  assert.ok(fs.existsSync(path.join(data, 'config.json')));
  assert.ok(fs.existsSync(path.join(repo, '.agent-dispatch-codex', 'config.json')));
  const workerProfile = path.join(repo, '.codex', 'agents', 'dispatch_worker.toml');
  assert.ok(fs.existsSync(workerProfile));
  assert.doesNotMatch(fs.readFileSync(workerProfile, 'utf8'), /^model = /m);
  assert.doesNotMatch(fs.readFileSync(workerProfile, 'utf8'), /^model_reasoning_effort = /m);
  assert.match(session.hookSpecificOutput.additionalContext, /do not leave idle agents occupying limited slots/);
  assert.match(session.hookSpecificOutput.additionalContext, /keyword routes are fallible suggestions/i);
  assert.match(session.hookSpecificOutput.additionalContext, /full conversation and the latest explicit user instructions/i);
  assert.match(session.hookSpecificOutput.additionalContext, /no routing hint does not preserve an earlier route/i);
  assert.match(session.hookSpecificOutput.additionalContext, /For every new or reused review agent/);
  assert.match(session.hookSpecificOutput.additionalContext, /observable host model\/effort metadata/);
  assert.match(session.hookSpecificOutput.additionalContext, /family unresolved.*catalog-unavailable-or-stale/);
  assert.equal(fs.existsSync(path.join(repo, '.codex', 'agents', 'dispatch_sol_worker.toml')), false);

  const compactSession = parse(run('session_start', { hook_event_name: 'SessionStart', source: 'compact' }));
  assert.match(compactSession.hookSpecificOutput.additionalContext, /Delegate only when independent parallel work helps/);
  assert.match(compactSession.hookSpecificOutput.additionalContext, /at most 3 concurrent subagents/);
  assert.match(compactSession.hookSpecificOutput.additionalContext, /Complete local commit preparation/);
  assert.doesNotMatch(compactSession.hookSpecificOutput.additionalContext, /pre_tool_nudge/);
  assert.match(compactSession.hookSpecificOutput.additionalContext, /CodeMap Boost owns graph refresh and retrieval/);
  assert.match(compactSession.hookSpecificOutput.additionalContext, /For every new or reused review agent/);
  assert.match(compactSession.hookSpecificOutput.additionalContext, /keyword routes are fallible suggestions/);
  assert.match(compactSession.hookSpecificOutput.additionalContext, /later turn with no routing hint does not preserve an earlier route/);
  assert.doesNotMatch(compactSession.hookSpecificOutput.additionalContext, /Agent Dispatch policy for the primary Codex agent/);

  for (const source of ['resume', 'clear']) {
    const fullSession = parse(run('session_start', { hook_event_name: 'SessionStart', source }));
    assert.match(fullSession.hookSpecificOutput.additionalContext, /Agent Dispatch policy for the primary Codex agent/);
    assert.doesNotMatch(fullSession.hookSpecificOutput.additionalContext, /Delegate only when independent parallel work helps/);
  }

  // Check the real hook entry point: catalog selection, generated TOML, and guidance must use the same pair.
  const codexHome = path.join(temp, 'codex-home');
  fs.mkdirSync(codexHome);
  const catalogPath = path.join(codexHome, 'models_cache.json');
  const solProfile = path.join(repo, '.codex', 'agents', 'dispatch_sol_worker.toml');
  for (const [models, model, effort] of [
    [[['gpt-6.1-sol', ['high']], ['gpt-6-sol', ['medium', 'high']]], 'gpt-6.1-sol', 'high'],
    [[['gpt-6-sol', ['medium', 'high']]], 'gpt-6-sol', 'high'],
    [[['gpt-6.1-sol', ['medium']], ['gpt-6-sol', ['medium', 'high']]], 'gpt-6-sol', 'high'],
    [[['gpt-7-sol', ['high']], ['gpt-8-sol', ['medium']]], 'gpt-7-sol', 'high'],
  ]) {
    fs.writeFileSync(catalogPath, JSON.stringify({
      fetched_at: new Date().toISOString(),
      models: models.map(([slug, efforts]) => ({
        slug, supported_reasoning_levels: efforts.map((effort) => ({ effort })),
      })),
    }));
    const context = parse(run('session_start', { source: 'startup' })).hookSpecificOutput.additionalContext;
    assert.ok(context.includes(`${model}/${effort} candidate for code writing`));
    const toml = fs.readFileSync(solProfile, 'utf8');
    assert.ok(toml.includes(`model = "${model}"`));
    assert.ok(toml.includes(`model_reasoning_effort = "${effort}"`));
    assert.doesNotMatch(toml, /^model_candidates/m, 'plugin metadata is not a native TOML field');
    assert.doesNotMatch(toml, /^model_resolution/m, 'resolution diagnostics are not native TOML fields');
    const prompt = parse(run('user_prompt_submit', { prompt: '\u8bf7\u5b9e\u73b0\u8fd9\u4e2a\u5e38\u89c4\u529f\u80fd' }));
    assert.ok(prompt.hookSpecificOutput.additionalContext.includes(`dispatch_sol_worker (${model}/${effort})`));
    const compact = parse(run('session_start', { source: 'compact' }));
    assert.ok(compact.hookSpecificOutput.additionalContext.includes(`Use the effective ${model}/${effort} candidate for writing`));
  }
  fs.writeFileSync(catalogPath, '{invalid');
  const damaged = parse(run('session_start', { source: 'startup' })).hookSpecificOutput.additionalContext;
  assert.equal(fs.existsSync(solProfile), false, 'damaged catalog removes the obsolete managed role');
  assert.match(damaged, /family unresolved/);
  const unresolvedPrompt = parse(run('user_prompt_submit', { prompt: 'implement this code module' })).hookSpecificOutput.additionalContext;
  assert.match(unresolvedPrompt, /host-supported full model ID and effort explicitly/);
  assert.doesNotMatch(unresolvedPrompt, /dispatch_sol_worker \(|explicit sol\/high/);
  fs.unlinkSync(catalogPath);
  assert.match(parse(run('session_start', { source: 'startup' })).hookSpecificOutput.additionalContext, /catalog-unavailable-or-stale/);
  // Restore an isolated visible catalog for the remaining routing behavior checks.
  fs.writeFileSync(catalogPath, JSON.stringify(require('./model_fixture.cjs').cache));

  assert.equal(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u89e3\u91ca\u8fd9\u4e00\u884c',
  }), '');
  const prompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u8bf7\u5ba1\u67e5\u5e76\u8fc1\u79fb\u591a\u4e2a\u63d2\u4ef6\uff0c\u7136\u540e\u5e76\u884c\u9a8c\u8bc1\u5b9e\u73b0',
  }));
  assert.equal(prompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(prompt.hookSpecificOutput.additionalContext, /Task route:/);
  assert.match(prompt.hookSpecificOutput.additionalContext, /candidate suggestion \(inferred from this message only\)/);
  assert.match(prompt.hookSpecificOutput.additionalContext, /dispatch_mapper|dispatch_explorer|dispatch_reviewer|dispatch_worker/);
  assert.doesNotMatch(prompt.hookSpecificOutput.additionalContext, /Agent Dispatch policy for the primary Codex agent/);

  const explicitReadOnly = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u5148\u4e0d\u8981\u6539\u4ee3\u7801\uff0c\u53ea\u5206\u6790\u95ee\u9898\u3002',
  }));
  assert.match(explicitReadOnly.hookSpecificOutput.additionalContext, /diagnosis/);
  assert.match(explicitReadOnly.hookSpecificOutput.additionalContext, /candidate suggestion \(inferred from this message only\)/);
  assert.match(explicitReadOnly.hookSpecificOutput.additionalContext, /full conversation and latest explicit user instructions/);
  assert.match(explicitReadOnly.hookSpecificOutput.additionalContext, /confirmed read-only scope/);
  assert.doesNotMatch(explicitReadOnly.hookSpecificOutput.additionalContext, /do not perform the fix/);

  assert.equal(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u5f00\u59cb\u5de5\u4f5c\u5427\u3002',
  }), '');

  const explicitImplementation = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u8bf7\u5b9e\u73b0\u4ea7\u54c1\u529f\u80fd\uff1a\u7528\u6237\u4e0d\u4fee\u6539\u503c\u65f6\u4f7f\u7528\u9ed8\u8ba4\u503c\u3002',
  }));
  assert.match(explicitImplementation.hookSpecificOutput.additionalContext, /ordinary implementation/);
  assert.match(explicitImplementation.hookSpecificOutput.additionalContext, /candidate suggestion \(inferred from this message only\)/);
  assert.match(explicitImplementation.hookSpecificOutput.additionalContext, /full conversation and latest explicit user instructions/);
  assert.doesNotMatch(explicitImplementation.hookSpecificOutput.additionalContext, /do not perform the fix/);

  const hardPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u8bf7\u5b9e\u73b0\u4e00\u4e2a\u56f0\u96be\u4e14\u590d\u6742\u7684\u529f\u80fd\uff0c\u5e76\u6392\u67e5\u590d\u6742\u8c03\u8bd5\u95ee\u9898',
  }));
  assert.match(hardPrompt.hookSpecificOutput.additionalContext, /writable/);
  assert.match(hardPrompt.hookSpecificOutput.additionalContext, /model and effort/);
  assert.match(hardPrompt.hookSpecificOutput.additionalContext, /primary agent.*accept/);
  assert.match(hardPrompt.hookSpecificOutput.additionalContext, /dispatch_sol_worker.*gpt-6-sol\/high/);
  assert.doesNotMatch(hardPrompt.hookSpecificOutput.additionalContext, /dispatch_luna_worker/);

  const plannedHardPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u8bf7\u5148\u5236\u5b9a\u8de8\u6a21\u5757\u67b6\u6784\u8ba1\u5212\uff0c\u7136\u540e\u5b9e\u73b0\u56f0\u96be\u7684\u590d\u6742\u8c03\u8bd5\u4efb\u52a1',
  }));
  assert.match(plannedHardPrompt.hookSpecificOutput.additionalContext, /dispatch_planner/);
  assert.match(plannedHardPrompt.hookSpecificOutput.additionalContext, /writable/);
  assert.match(plannedHardPrompt.hookSpecificOutput.additionalContext, /without replanning/);
  assert.doesNotMatch(plannedHardPrompt.hookSpecificOutput.additionalContext, /must use two serial phases|must spawn/);
  assert.match(plannedHardPrompt.hookSpecificOutput.additionalContext, /dispatch_sol_worker.*gpt-6-sol\/high/);
  assert.doesNotMatch(plannedHardPrompt.hookSpecificOutput.additionalContext, /dispatch_luna_worker/);

  const searchPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u8bf7\u641c\u7d22\u591a\u4e2a\u6587\u4ef6\u4e2d\u7684\u8c03\u7528\u94fe\u548c\u5f71\u54cd\u9762',
  }));
  assert.match(searchPrompt.hookSpecificOutput.additionalContext, /dispatch_luna_worker/);
  assert.match(searchPrompt.hookSpecificOutput.additionalContext, /gpt-6-luna\/max/);
  assert.match(searchPrompt.hookSpecificOutput.additionalContext, /CodeMap Boost owns graph refresh/);
  assert.match(searchPrompt.hookSpecificOutput.additionalContext, /do not repeat build\/update/);

  for (const prompt of [
    '\u68c0\u7d22\u6700\u8fd1\u6784\u5efa\u65e5\u5fd7\u5e76\u6458\u5f55\u5931\u8d25\u539f\u56e0',
    '\u8bfb\u53d6\u8fd9\u4e9b Markdown \u6587\u6863\uff0c\u6c47\u603b\u91cd\u590d\u6761\u76ee',
    '\u8fd0\u884c\u73b0\u6709 CTest \u7528\u4f8b\uff0c\u6c47\u603b\u5931\u8d25\u8f93\u51fa',
  ]) {
    const lowCostPrompt = parse(run('user_prompt_submit', {
      hook_event_name: 'UserPromptSubmit',
      prompt,
    }));
    assert.match(lowCostPrompt.hookSpecificOutput.additionalContext, /low-cost/);
    assert.match(lowCostPrompt.hookSpecificOutput.additionalContext, /gpt-6-luna\/max/);
    assert.match(lowCostPrompt.hookSpecificOutput.additionalContext, /dispatch_luna_worker/);
  }

  const deliveryPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u6309\u5df2\u6279\u51c6\u65b9\u6848\u5236\u4f5c UI \u539f\u578b',
  }));
  assert.match(deliveryPrompt.hookSpecificOutput.additionalContext, /content production or deliverable execution/);
  assert.match(deliveryPrompt.hookSpecificOutput.additionalContext, /writable/);
  assert.doesNotMatch(deliveryPrompt.hookSpecificOutput.additionalContext, /dispatch_planner|CodeMap Boost/);

  const verificationPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Run tests to verify the fix, do not modify product code',
  }));
  assert.match(verificationPrompt.hookSpecificOutput.additionalContext, /verification execution/);
  assert.match(verificationPrompt.hookSpecificOutput.additionalContext, /dispatch_tester/);
  assert.doesNotMatch(verificationPrompt.hookSpecificOutput.additionalContext, /writable/);

  for (const verificationOnly of [
    'Run tests to verify the fix',
    'Run the test plan against the prototype',
  ]) {
    const output = parse(run('user_prompt_submit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: verificationOnly,
    }));
    assert.match(output.hookSpecificOutput.additionalContext, /verification execution/);
    assert.match(output.hookSpecificOutput.additionalContext, /dispatch_tester/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /writable|dispatch_planner/);
  }

  for (const planCreation of ['\u7f16\u5199 QA \u6d4b\u8bd5\u8ba1\u5212', 'Write a test plan']) {
    const output = parse(run('user_prompt_submit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: planCreation,
    }));
    assert.match(output.hookSpecificOutput.additionalContext, /dispatch_planner/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /writable|dispatch_tester/);
  }

  const modificationPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Run tests and fix failures',
  }));
  assert.match(modificationPrompt.hookSpecificOutput.additionalContext, /ordinary implementation/);
  assert.match(modificationPrompt.hookSpecificOutput.additionalContext, /writable/);
  assert.doesNotMatch(modificationPrompt.hookSpecificOutput.additionalContext, /dispatch_tester/);

  const presentationPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Prepare a design presentation for the stakeholder meeting, including customer needs, journey stages, visual direction, and the final handoff checklist.',
  }));
  assert.match(presentationPrompt.hookSpecificOutput.additionalContext, /content production or deliverable execution/);
  assert.doesNotMatch(presentationPrompt.hookSpecificOutput.additionalContext, /dispatch_planner/);

  const researchPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'research competitor pricing from official sources',
  }));
  assert.match(researchPrompt.hookSpecificOutput.additionalContext, /external research/);
  assert.match(researchPrompt.hookSpecificOutput.additionalContext, /dispatch_researcher/);
  assert.doesNotMatch(researchPrompt.hookSpecificOutput.additionalContext, /CodeMap Boost/);

  const designReviewPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Review onboarding design for accessibility',
  }));
  assert.match(designReviewPrompt.hookSpecificOutput.additionalContext, /ordinary review/);
  assert.match(designReviewPrompt.hookSpecificOutput.additionalContext, /dispatch_reviewer/);
  assert.doesNotMatch(designReviewPrompt.hookSpecificOutput.additionalContext, /CodeMap Boost|code graph|graph quer/);

  const patchReviewPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Please inspect this patch for regressions',
  }));
  assert.match(patchReviewPrompt.hookSpecificOutput.additionalContext, /dispatch_reviewer/);
  assert.match(patchReviewPrompt.hookSpecificOutput.additionalContext, /CodeMap Boost|graph quer/);

  const reviewModelPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '\u8bf7\u5ba1\u67e5\u672c\u6b21\u6539\u52a8',
  }));
  assert.match(reviewModelPrompt.hookSpecificOutput.additionalContext, /ordinary review/);
  assert.match(reviewModelPrompt.hookSpecificOutput.additionalContext, /dispatch_reviewer/);
  assert.match(reviewModelPrompt.hookSpecificOutput.additionalContext, /For every new or reused review agent/);
  assert.match(reviewModelPrompt.hookSpecificOutput.additionalContext, /choose a supported model/);

  const clothingReviewPrompt = parse(run('user_prompt_submit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Review the patch design for a jacket',
  }));
  assert.match(clothingReviewPrompt.hookSpecificOutput.additionalContext, /dispatch_reviewer/);
  assert.doesNotMatch(clothingReviewPrompt.hookSpecificOutput.additionalContext, /CodeMap Boost|code graph|graph quer/);

  const subagent = parse(run('subagent_start', {
    hook_event_name: 'SubagentStart',
    agent_id: 'a-1',
    agent_type: 'worker',
  }));
  assert.match(subagent.hookSpecificOutput.additionalContext, /spawned subagent/);
  assert.match(subagent.hookSpecificOutput.additionalContext, /Do not run Git commands/);
  assert.match(subagent.hookSpecificOutput.additionalContext, /If assigned a review but the actual model\/effort differs/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
