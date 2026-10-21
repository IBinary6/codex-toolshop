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

function testRuntimeMigration(data) {
  const options = { pluginDataDir: data };
  const legacyDir = crgRuntimePaths(options).dir;
  metadata(legacyDir, '2.3.7');
  const marker = path.join(legacyDir, 'preserve.txt');
  fs.writeFileSync(marker, 'old runtime remains available');
  const selected = selectCrgRuntime(options);
  assert.equal(selected.version, '', 'ordinary migration requests latest stable CRG without a version pin');
  assert.equal(selected.expectedVersion, '');
  assert.equal(selected.runtimeDir, path.join(data, 'crg-compatible-runtime'));
  assert.equal(fs.existsSync(selected.runtimeDir), false, 'selection never installs or overwrites a runtime');
  assert.equal(recordSelectedCrgRuntime(selected), false, 'unprepared migration must not publish');
  const preparation = { ...selected, enableCodeMap: () => {}, scheduleRuntimeUpdates: () => {} };
  assert.equal(prepareMcpServer({ ...preparation, ensureCrg: () => false, readBootstrapFailure: () => '' }).ok, false);
  assert.equal(readRuntimeVersions(options).active, undefined, 'failed preparation retains old pointer');
  assert.equal(prepareMcpServer({ ...preparation, ensureCrg(runtimeOptions) {
    assert.equal(runtimeOptions.runtimeDir, selected.runtimeDir);
    assert.equal(runtimeOptions.expectedVersion, '');
    metadata(runtimeOptions.runtimeDir, '2.10.0');
    return true;
  } }).ok, true);
  assert.equal(readRuntimeVersions(options).active, undefined, 'nonversioned directory cannot publish a versioned pointer');
  assert.equal(selectCrgRuntime(options).version, '2.10.0', 'next connection reuses actual compatible metadata');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'old runtime remains available');
  assert.equal(diskRuntimeVersion(legacyDir), '2.3.7');

  const oldActiveDir = crgRuntimePaths({ ...options, version: '2.3.7' }).dir;
  metadata(oldActiveDir, '2.3.7');
  promoteRuntimeVersion('serena', '1.7.0', options);
  promoteRuntimeVersion('crg', '2.3.7', options);
  const migration = selectCrgRuntime(options);
  assert.equal(migration.version, '2.10.0', 'old active pointer selects the existing compatible runtime');
  assert.equal(migration.runtimeDir, selected.runtimeDir);
  assert.equal(selectCrgRuntime(migration).version, '2.10.0', 'repeat selection keeps connection snapshot');
  assert.equal(recordSelectedCrgRuntime(migration), false, 'compatible directory must not create a missing versioned pointer');
  const absentMigrationDir = path.join(data, 'candidate-check');
  const explicitMissing = selectCrgRuntime({ ...options, runtimeDir: absentMigrationDir });
  assert.equal(explicitMissing.version, '', 'explicit missing directory must not inherit incompatible active version');
  assert.equal(explicitMissing.expectedVersion, '');
  assert.equal(selectCrgRuntime(explicitMissing).version, '');
  const candidate = selectCrgRuntime({ ...options, version: '2.4.0' });
  metadata(candidate.runtimeDir, '2.4.0');
  const held = acquireUpdateLock(options);
  assert.equal(recordSelectedCrgRuntime(candidate), false, 'versioned activation shares updater lock');
  releaseUpdateLock(held);
  assert.equal(recordSelectedCrgRuntime(candidate), true, 'verified versioned candidate replaces old incompatible pointer');
  assert.equal(readRuntimeVersions(options).active.serena, '1.7.0');
  assert.equal(diskRuntimeVersion(oldActiveDir), '2.3.7');
  promoteRuntimeVersion('crg', '2.3.7', options);
  const stale = selectCrgRuntime({ ...options, version: '2.4.0' });
  promoteRuntimeVersion('crg', '2.10.0', options);
  assert.equal(recordSelectedCrgRuntime(stale), false, 'concurrent newer promotion cannot be rolled back');
  assert.equal(readRuntimeVersions(options).active.crg, '2.10.0');

  for (const version of ['2.3.8', '2.3.9', '2.10.0']) {
    const runtimeDir = crgRuntimePaths({ ...options, version }).dir;
    metadata(runtimeDir, version);
    promoteRuntimeVersion('crg', version, options);
    const healthy = selectCrgRuntime(options);
    assert.equal(healthy.version, version);
    assert.equal(healthy.runtimeDir, runtimeDir, 'compatible active runtime keeps its exact path');
  }
  const diagnostics = [];
  const explicitVersion = selectCrgRuntime({ ...options, version: '2.3.7', diagnostics });
  assert.equal(explicitVersion.version, '2.3.7');
  assert.equal(explicitVersion.runtimeDir, oldActiveDir);
  assert.match(explicitVersion.compatibilityDiagnostic, /2\.3\.7.*2\.3\.8/);
  assert.ok(diagnostics.includes(explicitVersion.compatibilityDiagnostic));
  const explicitDirectory = selectCrgRuntime({ ...options, runtimeDir: legacyDir });
  assert.equal(explicitDirectory.runtimeDir, legacyDir);
  assert.equal(explicitDirectory.version, '2.3.7', 'explicit doctor directory uses its own metadata, not active pointer');
  assert.match(explicitDirectory.compatibilityDiagnostic, /2\.3\.7.*2\.3\.8/);
  assert.equal(recordSelectedCrgRuntime(explicitVersion), false, 'incompatible explicit candidate cannot be activated');

  // An active pointer alone must not hide incompatible metadata in its runtime directory.
  const mismatchedData = path.join(data, 'mismatch');
  const mismatchOptions = { pluginDataDir: mismatchedData };
  promoteRuntimeVersion('crg', '2.4.0', mismatchOptions);
  metadata(crgRuntimePaths(mismatchOptions).dir, '2.3.7');
  const mismatch = selectCrgRuntime(mismatchOptions);
  assert.equal(mismatch.version, '');
  assert.equal(mismatch.runtimeDir, path.join(mismatchedData, 'crg-compatible-runtime'));
  assert.equal(selectCrgRuntime(mismatch).version, '', 'repeated migration selection cannot inherit old active pointer');
  metadata(mismatch.runtimeDir, '2.3.7');
  assert.throws(() => selectCrgRuntime(mismatchOptions), /CRG 2\.3\.7.*crg-compatible-runtime.*requires CRG >= 2\.3\.8/,
    'incompatible compatibility-directory metadata must fail clearly instead of passing generic grammar probes');
  assert.equal(diskRuntimeVersion(mismatch.runtimeDir), '2.3.7', 'failed migration does not overwrite existing directory');
}

async function main() {
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-catalog-')));
  try {
    testRuntimeMigration(path.join(data, 'migration'));
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
