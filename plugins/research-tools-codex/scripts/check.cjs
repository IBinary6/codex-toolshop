'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const manifest = require('../.codex-plugin/plugin.json');
const pkg = require('../package.json');
const mcp = require('../.mcp.json');
const catalog = require('./catalog.json');
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.version, '0.1.4');
assert.deepEqual(Object.keys(mcp.mcpServers), ['research-tools']);
assert.equal(mcp.mcpServers['research-tools'].cwd, '.');
assert.deepEqual(mcp.mcpServers['research-tools'].args, ['scripts/server.cjs']);
assert.deepEqual(require('../config.example.json'), { version: 1, context7: { apiKey: '' }, exa: { apiKey: '' }, tavily: { apiKey: '' } });
const expected = { context7: ['resolve-library-id', 'query-docs'], exa: ['web_search_exa', 'web_fetch_exa'], tavily: ['tavily_search', 'tavily_extract', 'tavily_crawl', 'tavily_map', 'tavily_research'], microsoft: ['microsoft_docs_search', 'microsoft_code_sample_search', 'microsoft_docs_fetch'], fetch: ['fetch'], sequentialthinking: ['sequentialthinking'] };
assert.deepEqual(Object.keys(catalog.providers), Object.keys(expected));
assert.equal(Object.values(catalog.providers).flat().length, 14);
for (const [provider, names] of Object.entries(expected)) {
  assert.deepEqual(catalog.providers[provider].map(tool => tool.name), names);
  for (const tool of catalog.providers[provider]) assert.equal(tool.inputSchema.type, 'object');
}
assert.deepEqual(catalog.providers.exa[0].inputSchema.required, ['query']);
assert.ok(catalog.providers.exa[0].inputSchema.properties.objective);
assert.deepEqual(catalog.providers.fetch[0].inputSchema.required, ['url']);
assert.deepEqual(catalog.providers.sequentialthinking[0].inputSchema.required, ['thought', 'nextThoughtNeeded', 'thoughtNumber', 'totalThoughts']);
for (const name of ['nextThoughtNeeded', 'isRevision', 'needsMoreThoughts']) assert.deepEqual(catalog.providers.sequentialthinking[0].inputSchema.properties[name].type, ['boolean', 'string']);
for (const directory of ['scripts', 'test', 'packaging']) {
  for (const file of fs.readdirSync(path.join(root, directory)).filter(file => file.endsWith('.cjs'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `Syntax check failed: ${directory}/${file}`);
  }
}
const skill = fs.readFileSync(path.join(root, 'skills/research-tools/SKILL.md'), 'utf8');
assert.match(skill, /^---\nname: research-tools\ndescription:/);
console.log('Plugin manifest, catalog, template, skill and JavaScript syntax checks passed.');
