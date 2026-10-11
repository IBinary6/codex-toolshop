'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyGraphRecovery } = require('../../../scripts/crg-idle-smoke.cjs');

async function exercise({ restoredMode = 'hybrid', editedMode = 'fts', reembeddedMode = 'hybrid', staleGraph = false, missingEditedResult = false } = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-idle-smoke-test-'));
  const sample = path.join(fixture, 'sample.py');
  const original = 'def idle_greeting(name):\n    return "Hello " + name\n';
  fs.writeFileSync(sample, original);
  const calls = [];
  let graphCalls = 0, searchCalls = 0;
  try {
    const query = { query: 'welcome a visitor by name', repo_root: fixture, provider: 'local', limit: 3 };
    const result = await verifyGraphRecovery(async (name, parameters) => {
      calls.push(name);
      assert.equal(parameters.repo_root, fixture);
      if (name === 'query_graph_tool') {
        if (++graphCalls === 1) {
          assert.equal(fs.readFileSync(sample, 'utf8'), original, 'concurrent restore must happen before fixture edit');
          return { nodes: [{ name: 'idle_greeting' }] };
        }
        assert.match(fs.readFileSync(sample, 'utf8'), /idle_added_after_reclaim/);
        return { nodes: [{ name: staleGraph ? 'idle_greeting' : 'idle_added_after_reclaim' }] };
      }
      if (name === 'semantic_search_nodes_tool') {
        ++searchCalls;
        if (searchCalls === 1) {
          assert.equal(fs.readFileSync(sample, 'utf8'), original, 'old vectors are validated before editing');
          return { search_mode: restoredMode, results: [{ name: 'idle_greeting' }] };
        }
        if (searchCalls === 2) {
          assert.equal(graphCalls, 2, 'edited graph must refresh before first edited search');
          assert.equal(parameters.query, 'idle_added_after_reclaim');
          return { search_mode: editedMode, query: parameters.query, results: missingEditedResult ? [] : [{ name: 'idle_added_after_reclaim' }] };
        }
        assert.equal(calls.at(-2), 'embed_graph_tool', 'final hybrid search requires an explicit reembed');
        return { search_mode: reembeddedMode, results: [{ name: 'idle_greeting' }] };
      }
      assert.equal(name, 'embed_graph_tool');
      assert.equal(searchCalls, 2); assert.equal(parameters.provider, 'local');
      return { total_embeddings: 4 };
    }, fixture, query);
    return { result, calls };
  } finally { fs.unlinkSync(sample); fs.rmdirSync(fixture); }
}

async function main() {
  const { result, calls } = await exercise();
  assert.deepEqual(result, { vectorSearchRestoredBeforeEdit: true, editedGraphFresh: true,
    editedGraphSearchInitiallyFts: true, hybridSearchAfterReembed: true });
  assert.deepEqual(calls, ['query_graph_tool', 'semantic_search_nodes_tool', 'query_graph_tool',
    'semantic_search_nodes_tool', 'embed_graph_tool', 'semantic_search_nodes_tool']);
  assert.equal((await exercise({ editedMode: 'hybrid' })).result.editedGraphSearchInitiallyFts, false, 'legal vector mode remains acceptable immediately after refresh');
  await assert.rejects(exercise({ restoredMode: 'fts' }), /Unedited graphs must restore real vector search after reclamation/);
  await assert.rejects(exercise({ staleGraph: true }), /idle_added_after_reclaim/);
  await assert.rejects(exercise({ missingEditedResult: true }), /Post-edit search must return new symbols rather than echo the query/);
  await assert.rejects(exercise({ reembeddedMode: 'fts' }), /Explicit post-edit embedding must restore hybrid search/);
  console.log('crg_idle_smoke.test.js PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
