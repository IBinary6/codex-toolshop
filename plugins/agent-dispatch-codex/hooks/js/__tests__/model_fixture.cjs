'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseModelCatalog, resolveModelCandidates } = require('../lib/model_candidates');
const { loadDefaults } = require('../lib/config');

// An isolated catalog keeps routing/diagnostic tests independent of the developer's account and cache age.
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-catalog-fixture-'));
const cache = {
  fetched_at: new Date().toISOString(),
  models: ['luna', 'sol', 'astra'].map((family) => ({
    slug: `gpt-6-${family}`,
    visibility: 'list',
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', ...(family === 'luna' ? [] : ['ultra'])]
      .map((effort) => ({ effort })),
  })).concat({
    slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: ['medium', 'ultra', 'xhigh'].map((effort) => ({ effort })),
  }),
};
fs.writeFileSync(path.join(fixtureHome, 'models_cache.json'), JSON.stringify(cache));
process.env.CODEX_HOME = fixtureHome;
process.on('exit', () => fs.rmSync(fixtureHome, { recursive: true, force: true }));
const catalog = parseModelCatalog(cache);
module.exports = {
  cache,
  catalog,
  defaults: () => resolveModelCandidates(loadDefaults(), catalog),
};
