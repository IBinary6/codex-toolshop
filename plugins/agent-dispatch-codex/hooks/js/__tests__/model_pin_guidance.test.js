'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-pin-guidance-'));
const lib = path.resolve(__dirname, '..', 'lib');
// Each case gets a separate CODEX_HOME in a child process; no account cache or fixture import can mask missing records.
const script = `
const fs = require('fs');
const { loadDefaults, mergeConfig, readModelCatalog, resolveModelCandidates, modelEffortWarnings } = require(process.argv[1] + '/config');
const { promptGuidance } = require(process.argv[1] + '/guidance');
const { renderAgentProfile } = require(process.argv[1] + '/agent_profiles');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const target = { model: input.model, model_reasoning_effort: input.effort };
const profiles = { dispatch_luna_worker: input.generic ? { enabled: false } : target };
const config = resolveModelCandidates(mergeConfig(loadDefaults(), {
  policy: { low_cost: target }, agent_profiles: { profiles },
}), readModelCatalog());
const name = input.generic ? 'dispatch_worker' : 'dispatch_luna_worker';
const profile = config.agent_profiles.profiles[name];
console.log(JSON.stringify({
  route: promptGuidance('检索构建日志里的 crash 和 error', config),
  mixed: promptGuidance('根据构建日志修复复杂崩溃，并补回归测试', config),
  toml: input.family ? '' : renderAgentProfile(name, profile),
  warnings: modelEffortWarnings(config),
}));
`;

function run(name, cache, options = {}) {
  const codexHome = path.join(temporary, name);
  fs.mkdirSync(codexHome);
  if (cache !== undefined) fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify(cache));
  const result = spawnSync(process.execPath, ['-e', script, lib], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    env: { ...process.env, CODEX_HOME: codexHome },
    input: JSON.stringify({ model: 'gpt-6-luna', effort: 'max', ...options }),
    encoding: 'utf8',
    windowsHide: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const catalog = (model, efforts, age = 0) => ({
  fetched_at: new Date(Date.now() - age).toISOString(),
  models: [{ slug: model, visibility: 'list', supported_reasoning_levels: efforts.map((effort) => ({ effort })) }],
});

try {
  for (const generic of [false, true]) {
    for (const [name, cache] of [
      ['missing', undefined],
      ['stale', catalog('gpt-6-luna', ['medium'], 25 * 60 * 60 * 1000)],
      ['unlisted', catalog('gpt-99-sol', ['high'])],
    ]) {
      const result = run(`${name}-${generic}`, cache, { generic });
      const role = generic ? 'dispatch_worker' : 'dispatch_luna_worker';
      for (const text of [result.route, result.mixed]) {
        assert.ok(text.includes(`${role} (${generic ? 'explicit ' : ''}gpt-6-luna/max)`));
        assert.match(text, /catalog support unconfirmed; verify host support before spawning/);
        assert.doesNotMatch(text, /[Nn]o enabled low-cost role matches|no low-cost role matches/);
      }
      assert.match(result.warnings.join('\n'), /No fresh visible capability record for gpt-6-luna/);
      if (generic) assert.doesNotMatch(result.toml, /^model = /m);
      else assert.match(result.toml, /^model = "gpt-6-luna"/m);
    }
    const valid = run(`supported-${generic}`, catalog('gpt-6-luna', ['max']), { generic });
    assert.match(valid.route, /dispatch_(?:luna_)?worker.*gpt-6-luna\/max/);
    assert.doesNotMatch(valid.route, /catalog support unconfirmed/);
    const invalid = run(`unsupported-${generic}`, catalog('gpt-6-luna', ['medium']), { generic });
    assert.match(invalid.route, /No enabled low-cost role matches gpt-6-luna\/max/);
    assert.match(invalid.mixed, /no low-cost role matches gpt-6-luna\/max/);
    assert.doesNotMatch(invalid.route, /prefer dispatch_/);
    const inherited = run(`inherited-${generic}`, undefined, { generic, effort: '' });
    assert.match(inherited.route, /No enabled low-cost role matches/);
    assert.doesNotMatch(inherited.route, /prefer dispatch_/);
  }
  const family = run('unresolved-family', undefined, { model: 'luna', effort: 'max', family: true });
  assert.match(family.route, /No enabled low-cost role matches luna\/max/);
  assert.doesNotMatch(family.route, /prefer dispatch_/);
  const unpinned = run('unpinned-policy', undefined, { model: '', effort: '' });
  assert.match(unpinned.route, /No enabled low-cost role matches/);
  assert.doesNotMatch(unpinned.route, /prefer dispatch_/);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
