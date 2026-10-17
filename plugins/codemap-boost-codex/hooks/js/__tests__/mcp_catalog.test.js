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
  catalogPath, diskRuntimeVersion, loadCatalog, recordSelectedCrgRuntime, selectCrgRuntime, validateCatalog,
} = require('../lib/mcp-catalog');
const bundled = require('../../../scripts/mcp-catalog-2.3.9.json');

function metadata(dir, version) {
  const packageDir = path.join(dir, 'Lib', 'site-packages', `code_review_graph-${version}.dist-info`);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'METADATA'), `Name: code-review-graph\nVersion: ${version}\n`);
}

function catalogFor(version) {
  return { ...bundled, version, serverInfo: { ...bundled.serverInfo, version }, tools: bundled.tools.map((tool) => ({ ...tool, annotations: { readOnlyHint: true } })) };
}

async function main() {
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-catalog-')));
  try {
    let starts = 0;
    const exportedVersions = [];
    // Fake metadata exporter: prints the catalog for the version recorded in the runtime's installation metadata.
    const exporter = (runtimeDir) => (command, args, spawnOptions) => {
      starts++;
      assert.equal(command, crgRuntimePaths({ runtimeDir }).python);
      assert.ok(args.includes('-I') && args.includes('-B'));
      assert.equal(spawnOptions.env.CRG_TOOLS, '');
      const version = diskRuntimeVersion(runtimeDir);
      exportedVersions.push(version);
      // Pass only a file path through argv: the full catalog exceeds the Windows command-line length limit (spawn ENAMETOOLONG).
      const catalogFile = path.join(data, `exported-catalog-${starts}.json`);
      fs.writeFileSync(catalogFile, JSON.stringify(catalogFor(version)), 'utf8');
      return spawn(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))', catalogFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    };
    const options = { pluginDataDir: data, env: {}, catalogSpawn: () => { starts++; throw new Error('known catalog must not spawn'); } };

    // Fresh install: nothing is pinned, so the first installation requests the latest stable CRG into the legacy directory.
    const legacyDir = path.join(data, 'crg-runtime');
    const fresh = selectCrgRuntime(options);
    assert.equal(fresh.version, '', 'fresh install must not pin a CRG version');
    assert.equal(fresh.expectedVersion, '');
    assert.equal(fresh.runtimeDir, legacyDir);
    assert.equal(fs.existsSync(fresh.runtimeDir), false, 'runtime selection must not create venv');
    const freshDiscovery = await loadCatalog(fresh).then(() => null, (error) => error);
    assert.ok(freshDiscovery && freshDiscovery.backendDiscovery, 'no installed runtime: no catalog, discovery falls back to the backend');
    assert.equal(starts, 0, 'a missing runtime must not start Python');
    assert.equal(recordSelectedCrgRuntime(fresh), false, 'failed/absent installation must not publish active');
    let preparedExpected = 'unset', preparedRuntimeDir = '';
    assert.equal(prepareMcpServer({ ...fresh, ensureCrg(runtimeOptions) {
      preparedExpected = runtimeOptions.expectedVersion; preparedRuntimeDir = runtimeOptions.runtimeDir; return true;
    }, enableCodeMap: () => {}, scheduleRuntimeUpdates: () => {} }).ok, true);
    assert.equal(preparedExpected, '', 'fresh preparation requests the unpinned latest package');
    assert.equal(preparedRuntimeDir, legacyDir);

    // The installed version decides the catalog: an exact bundled match stays Node only.
    metadata(legacyDir, '2.3.9');
    const bundledInstall = selectCrgRuntime(options);
    assert.equal(bundledInstall.version, '2.3.9');
    assert.deepEqual(await loadCatalog(bundledInstall), bundled);
    assert.equal(starts, 0, 'exact bundled version match must remain Node only');

    // Existing runtime of any other version keeps working and gets an exported, cached catalog.
    fs.rmSync(path.join(legacyDir, 'Lib', 'site-packages', 'code_review_graph-2.3.9.dist-info'), { recursive: true });
    metadata(legacyDir, '2.4.0');
    const legacy = selectCrgRuntime(options);
    assert.equal(legacy.version, '2.4.0');
    assert.equal(legacy.runtimeDir, legacyDir);
    assert.equal(recordSelectedCrgRuntime(legacy), false, 'legacy runtime path cannot become a versioned pointer');
    const exported = catalogFor('2.4.0');
    const unknown = await loadCatalog({ ...legacy, catalogSpawn: exporter(legacyDir) });
    assert.equal(starts, 1);
    assert.deepEqual(unknown, exported, 'non-bundled installed version must use the exported catalog');
    assert.ok(fs.existsSync(catalogPath('2.4.0', options)));
    assert.deepEqual(await loadCatalog(legacy), exported, 'cache must avoid future Python metadata starts');
    assert.equal(starts, 1);

    // Changing the installed version invalidates the cache automatically.
    fs.rmSync(path.join(legacyDir, 'Lib', 'site-packages', 'code_review_graph-2.4.0.dist-info'), { recursive: true });
    metadata(legacyDir, '2.6.0');
    const upgraded = await loadCatalog({ ...selectCrgRuntime(options), catalogSpawn: exporter(legacyDir) });
    assert.equal(upgraded.version, '2.6.0', 'a new installed version must not be served the old cached catalog');
    assert.equal(starts, 2);
    assert.deepEqual(exportedVersions, ['2.4.0', '2.6.0']);
    assert.ok(fs.existsSync(catalogPath('2.6.0', options)));

    // Export failure falls back to backend discovery and never serves a stale catalog or writes a cache.
    fs.rmSync(path.join(legacyDir, 'Lib', 'site-packages', 'code_review_graph-2.6.0.dist-info'), { recursive: true });
    metadata(legacyDir, '2.7.0');
    for (const failing of [
      () => { starts++; throw new Error('python unavailable'); },
      () => { starts++; return spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); },
      () => { starts++; return spawn(process.execPath, ['-e', 'process.stdout.write("{}")'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); },
    ]) {
      const failure = await loadCatalog({ ...selectCrgRuntime(options), catalogSpawn: failing }).then(() => null, (error) => error);
      assert.ok(failure && failure.backendDiscovery, 'export failure must request backend discovery');
      assert.match(failure.message, /2\.7\.0/);
    }
    assert.equal(fs.existsSync(catalogPath('2.7.0', options)), false, 'failed export must not leave a cache entry');

    // Pointer-selected runtime: the old repair flow still works and the installed version wins over the pointer.
    fs.rmSync(legacyDir, { recursive: true, force: true });
    const pinned = selectCrgRuntime({ ...options, version: '2.3.9' });
    assert.equal(pinned.runtimeDir, crgRuntimePaths({ pluginDataDir: data, version: '2.3.9' }).dir);
    assert.equal(recordSelectedCrgRuntime(pinned), false, 'absent installation must not publish active');
    assert.deepEqual(await loadCatalog(pinned), bundled, 'a pinned but absent runtime still uses its exact bundled catalog');
    metadata(pinned.runtimeDir, '2.3.9');
    promoteRuntimeVersion('serena', '1.7.0', options);
    const held = acquireUpdateLock(options);
    assert.equal(recordSelectedCrgRuntime(pinned), false, 'first promotion must not race updater holding shared lock');
    assert.equal(readRuntimeVersions(options).active.crg, undefined);
    releaseUpdateLock(held);
    assert.equal(recordSelectedCrgRuntime(pinned), true);
    assert.equal(readRuntimeVersions(options).active.serena, '1.7.0', 'first CRG promotion preserves Serena pointer');
    assert.equal(recordSelectedCrgRuntime(pinned), false, 'already active selection remains unchanged');
    // A known damaged runtime still discovers a matching catalog; the first actual preparation can repair the exact version.
    metadata(pinned.runtimeDir, '2.2.0');
    fs.rmSync(path.join(pinned.runtimeDir, 'Lib', 'site-packages', 'code_review_graph-2.3.9.dist-info'), { recursive: true });
    assert.equal(diskRuntimeVersion(pinned.runtimeDir), '2.2.0');
    fs.rmSync(path.join(pinned.runtimeDir, 'Lib', 'site-packages', 'code_review_graph-2.2.0.dist-info'), { recursive: true });
    assert.equal((await loadCatalog(pinned)).version, '2.3.9');
    let repairedVersion = '';
    const repaired = prepareMcpServer({ ...pinned,
      ensureCrg(runtimeOptions) {
        repairedVersion = runtimeOptions.expectedVersion;
        assert.equal(runtimeOptions.runtimeDir, pinned.runtimeDir);
        metadata(pinned.runtimeDir, runtimeOptions.expectedVersion);
        return true;
      }, enableCodeMap: () => {}, scheduleRuntimeUpdates: () => {},
    });
    assert.equal(repaired.ok, true); assert.equal(repairedVersion, '2.3.9');
    assert.equal(diskRuntimeVersion(pinned.runtimeDir), '2.3.9', 'known broken runtime repairs the exact installed version');
    const filtered = await loadCatalog({ ...pinned, env: { CRG_TOOLS: 'query_graph_tool, unknown' } });
    assert.equal(filtered.tools.length, 1);
    assert.equal(filtered.tools[0].name, 'query_graph_tool');
    assert.deepEqual(filtered.tools[0], bundled.tools.find((tool) => tool.name === 'query_graph_tool'), 'schema/annotations/outputSchema must be preserved verbatim');
    assert.equal(filtered.prompts.length, bundled.prompts.length);

    // A pointer that disagrees with the installed version is described by the installed version, not the pointer.
    fs.rmSync(path.join(pinned.runtimeDir, 'Lib', 'site-packages', 'code_review_graph-2.3.9.dist-info'), { recursive: true });
    promoteRuntimeVersion('crg', '2.5.0', options);
    assert.equal(selectCrgRuntime(options).version, '2.5.0');
    const mismatchDir = crgRuntimePaths({ ...options, version: '2.5.0' }).dir;
    metadata(mismatchDir, '2.4.0');
    assert.deepEqual(await loadCatalog(options), exported, 'installed 2.4.0 under a 2.5.0 pointer uses the 2.4.0 catalog');
    assert.equal(selectCrgRuntime(legacy).runtimeDir, legacy.runtimeDir, 'already selected session remains frozen across background promotion');
    assert.throws(() => validateCatalog(exported, '2.3.9'), /does not match/);
    assert.deepEqual(unknown.tools[0].annotations, { readOnlyHint: true });
    assert.ok(bundled.tools.some((tool) => tool.outputSchema));
    console.log('mcp_catalog.test.js PASS');
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
