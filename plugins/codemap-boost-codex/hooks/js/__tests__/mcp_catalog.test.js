'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { promoteRuntimeVersion, readRuntimeVersions } = require('../lib/runtime-versions');
const { acquireUpdateLock, releaseUpdateLock } = require('../lib/runtime-updates');
const { prepareMcpServer } = require('../../../scripts/mcp-server.cjs');
const { crgRuntimePaths } = require('../lib/bootstrap');
const {
  BUNDLED_CRG_VERSION, catalogPath, diskRuntimeVersion, loadCatalog, recordSelectedCrgRuntime, selectCrgRuntime, validateCatalog,
} = require('../../../scripts/mcp-catalog.cjs');
const bundled = require('../../../scripts/mcp-catalog-2.3.9.json');

function metadata(dir, version) {
  const packageDir = path.join(dir, 'Lib', 'site-packages', `code_review_graph-${version}.dist-info`);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'METADATA'), `Name: code-review-graph\nVersion: ${version}\n`);
}

async function main() {
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-catalog-')));
  try {
    let starts = 0;
    const options = { pluginDataDir: data, env: {}, catalogSpawn: () => { starts++; throw new Error('known catalog must not spawn'); } };
    const first = selectCrgRuntime(options);
    assert.equal(first.version, BUNDLED_CRG_VERSION);
    assert.equal(first.runtimeDir, crgRuntimePaths({ pluginDataDir: data, version: BUNDLED_CRG_VERSION }).dir);
    assert.equal(fs.existsSync(first.runtimeDir), false, 'runtime selection must not create venv');
    assert.deepEqual(await loadCatalog(first), bundled);
    assert.equal(starts, 0, 'fresh and known 2.3.9 discovery must remain Node only');
    assert.equal(recordSelectedCrgRuntime(first), false, 'failed/absent installation must not publish active');
    metadata(first.runtimeDir, '2.3.9');
    promoteRuntimeVersion('serena', '1.7.0', options);
    const held = acquireUpdateLock(options);
    assert.equal(recordSelectedCrgRuntime(first), false, 'first promotion must not race updater holding shared lock');
    assert.equal(readRuntimeVersions(options).active.crg, undefined);
    releaseUpdateLock(held);
    assert.equal(recordSelectedCrgRuntime(first), true);
    assert.equal(readRuntimeVersions(options).active.serena, '1.7.0', 'first CRG promotion preserves Serena pointer');
    assert.equal(recordSelectedCrgRuntime(first), false, 'already active selection remains unchanged');
    // A known damaged runtime still discovers a matching catalog; the first actual preparation can repair the exact version.
    metadata(first.runtimeDir, '2.2.0');
    fs.rmSync(path.join(first.runtimeDir, 'Lib', 'site-packages', 'code_review_graph-2.3.9.dist-info'), { recursive: true });
    assert.equal((await loadCatalog(first)).version, '2.3.9');
    let repairedVersion = '';
    const repaired = prepareMcpServer({ ...first,
      ensureCrg(runtimeOptions) {
        repairedVersion = runtimeOptions.expectedVersion;
        assert.equal(runtimeOptions.runtimeDir, first.runtimeDir);
        fs.rmSync(path.join(first.runtimeDir, 'Lib', 'site-packages', 'code_review_graph-2.2.0.dist-info'), { recursive: true });
        metadata(first.runtimeDir, runtimeOptions.expectedVersion);
        return true;
      }, enableCodeMap: () => {}, scheduleRuntimeUpdates: () => {},
    });
    assert.equal(repaired.ok, true); assert.equal(repairedVersion, '2.3.9');
    assert.equal(diskRuntimeVersion(first.runtimeDir), '2.3.9', 'known broken runtime prepares the advertised catalog version');
    fs.rmSync(path.join(data, 'runtime-versions.json'));
    const filtered = await loadCatalog({ ...first, env: { CRG_TOOLS: 'query_graph_tool, unknown' } });
    assert.equal(filtered.tools.length, 1);
    assert.equal(filtered.tools[0].name, 'query_graph_tool');
    assert.deepEqual(filtered.tools[0], bundled.tools.find((tool) => tool.name === 'query_graph_tool'), 'schema/annotations/outputSchema must be preserved verbatim');
    assert.equal(filtered.prompts.length, bundled.prompts.length);
    metadata(path.join(data, 'crg-runtime'), '2.4.0');
    const legacy = selectCrgRuntime(options);
    assert.equal(legacy.version, '2.4.0');
    assert.equal(legacy.runtimeDir, path.join(data, 'crg-runtime'));
    assert.equal(recordSelectedCrgRuntime(legacy), false, 'legacy runtime path cannot become a versioned pointer');
    assert.equal(diskRuntimeVersion(legacy.runtimeDir), '2.4.0');
    const exported = { ...bundled, version: '2.4.0', serverInfo: { ...bundled.serverInfo, version: '2.4.0' }, tools: bundled.tools.map((tool) => ({ ...tool, annotations: { readOnlyHint: true } })) };
    const exportFile = path.join(data, 'export-fixture.json');
    fs.writeFileSync(exportFile, JSON.stringify(exported));
    const unknown = await loadCatalog({ ...legacy, catalogSpawn(command, args, spawnOptions) {
      starts++;
      assert.equal(command, crgRuntimePaths(legacy).python);
      assert.ok(args.includes('-I') && args.includes('-B'));
      assert.equal(spawnOptions.env.CRG_TOOLS, '');
      return spawn(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', exportFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } });
    assert.equal(starts, 1);
    assert.equal(unknown.version, '2.4.0', 'unknown legacy runtime cannot advertise bundled schema');
    assert.ok(fs.existsSync(catalogPath('2.4.0', options)));
    assert.deepEqual(await loadCatalog(legacy), exported, 'cache must avoid future Python metadata starts');
    promoteRuntimeVersion('crg', '2.5.0', options);
    assert.equal(selectCrgRuntime(options).version, '2.5.0');
    metadata(crgRuntimePaths({ ...options, version: '2.5.0' }).dir, '2.4.0');
    await assert.rejects(loadCatalog(options), /selected 2\.5\.0, installed 2\.4\.0/);
    assert.equal(selectCrgRuntime(legacy).runtimeDir, legacy.runtimeDir, 'already selected session remains frozen across background promotion');
    assert.throws(() => validateCatalog(exported, '2.3.9'), /does not match/);
    assert.deepEqual(unknown.tools[0].annotations, { readOnlyHint: true });
    assert.ok(bundled.tools.some((tool) => tool.outputSchema));
    console.log('mcp_catalog.test.js PASS');
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
