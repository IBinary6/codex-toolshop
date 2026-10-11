'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  crgRuntimePaths,
  ensureCrg,
  ensureGraphify,
  probeCrgRuntime,
} = require('../hooks/js/lib/bootstrap');
const {
  ENABLED_MARKER,
  enableCodeMap,
  ensureAgentsBlock,
  ensureGitignore,
  isCodeMapEnabled,
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  isLegacyUvxCrgMcpConfig,
  isPluginManagedLegacyCrgMcpConfig,
  isNativeCrgMcpConfig,
  parseMcpJson,
  removeLegacyCrgMcp,
  resolveCodexCommand,
  runCodexMcp,
  startCrgBuild,
} = require('../hooks/js/lib/codemap');
const {
  codexHome,
  markerPath,
  nodeRuntimeStatus,
  pluginDataDir,
  repoRoot,
} = require('../hooks/js/lib/runtime');

const args = new Set(process.argv.slice(2));

function log(message) {
  process.stdout.write(`${message}\n`);
}

function warn(message) {
  process.stderr.write(`${message}\n`);
}

function removeMarker(name) {
  try {
    fs.rmSync(markerPath(name), { force: true });
  } catch (_) {}
}

function usage() {
  log([
    'CodeMap Boost setup',
    '',
    'Usage:',
    '  node scripts/setup.cjs [--with-graphify] [--build] [--skip-install]',
    '  node scripts/setup.cjs --doctor',
    '',
    'Options:',
    '  --with-graphify  Also install optional graphifyy package when graphify is missing.',
    '  --build          Start an initial code-review-graph build after setup.',
    '  --skip-install   Do not install packages; require an already healthy managed CRG runtime.',
    '  --doctor         Run read-only diagnostics; do not install, repair, build, or edit files.',
  ].join('\n'));
}

/**
 * Read MCP configuration without add/remove so doctor does not change registration.
 * @example readMcpConfig(process.cwd())
 */
function readMcpConfig(cwd, options = {}) {
  const result = runCodexMcp(['mcp', 'get', 'code-review-graph', '--json'], { ...options, cwd });
  const output = `${result && result.stdout ? result.stdout : ''}\n${result && result.stderr ? result.stderr : ''}`;
  return {
    ok: !!result && !result.error && result.status === 0,
    config: parseMcpJson(output),
  };
}

/**
 * Read and validate bundled MCP declarations independently of user global configuration.
 * @example readNativeMcpConfig().ok
 */
function readNativeMcpConfig() {
  try {
    const file = path.join(__dirname, '..', '.mcp.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const config = parsed && parsed.mcpServers && parsed.mcpServers['code-review-graph'];
    return { ok: isNativeCrgMcpConfig(config, { allowRelativeCwd: true }), config };
  } catch (error) {
    return { ok: false, config: null, diagnostic: error.message };
  }
}

/**
 * Use managed Python to check refresh adapter/API compatibility read-only; a healthy CLI does not prove adapter compatibility.
 * @example checkRefreshAdapter(crgRuntimePaths()).ok
 */
function checkRefreshAdapter(managed, runtimeOk) {
  if (!runtimeOk) {
    return { ok: false, reason: 'Private runtime check failed; compatibility check not run' };
  }
  const adapter = path.join(__dirname, 'refresh_graph.py');
  let result;
  try {
    result = spawnSync(managed.python, ['-I', '-B', adapter, '--check-runtime'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
      windowsHide: process.platform === 'win32',
    });
  } catch (error) {
    result = { status: null, error, stdout: '', stderr: '' };
  }
  const errorCode = result && result.error && result.error.code;
  if (errorCode === 'ETIMEDOUT') {
    return { ok: false, reason: 'Compatibility check timed out (ETIMEDOUT)' };
  }
  if (!result || result.error || result.status !== 0 || result.signal) {
    const diagnostic = String(result && (result.stderr || result.stdout) || '').trim();
    const outcome = result && result.error
      ? `Execution error (${errorCode || 'UNKNOWN'})`
      : result && result.signal
        ? `Terminated by signal ${result.signal}`
        : `Exit code ${result && result.status != null ? result.status : 'unknown'}`;
    return { ok: false, reason: diagnostic ? `${outcome}: ${diagnostic}` : outcome };
  }
  const output = String(result.stdout || '').trim();
  try {
    const parsed = JSON.parse(output);
    if (parsed && parsed.status === 'ok') {
      const version = parsed.crg_version ? `, CRG ${parsed.crg_version}` : '';
      return { ok: true, reason: `Adapter interface and parser probe passed${version}` };
    }
    return { ok: false, reason: `Result did not pass: ${output || 'empty output'}` };
  } catch (_) {
    return { ok: false, reason: `Invalid returned JSON: ${output || 'empty output'}` };
  }
}

/**
 * Run read-only health checks and indicate repair requirements through exit codes.
 * @example runDoctor(process.cwd())
 */
function runDoctor(cwd) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const nodeStatus = nodeRuntimeStatus();
  const home = codexHome();
  const data = pluginDataDir();
  const managed = crgRuntimePaths();
  const root = repoRoot(cwd);
  const codexPath = resolveCodexCommand({ cwd });
  const codexVersion = codexPath
    ? runCodexMcp(['--version'], { cwd, codexCommand: codexPath })
    : null;
  const codexOk = !!codexVersion && !codexVersion.error && codexVersion.status === 0;
  const versionText = String(codexVersion && codexVersion.stdout ? codexVersion.stdout : '').trim();
  const runtimeDiagnostics = [];
  const runtimeOk = probeCrgRuntime({ diagnostics: runtimeDiagnostics });
  const refreshAdapter = checkRefreshAdapter(managed, runtimeOk);
  const nativeMcp = readNativeMcpConfig();
  const resolvedMcp = codexOk
    ? readMcpConfig(cwd, { codexCommand: codexPath })
    : { ok: false, config: null, unavailable: true };
  const nativePluginRoot = path.resolve(__dirname, '..');
  const resolvedLooksNative = resolvedMcp.ok && isNativeCrgMcpConfig(resolvedMcp.config, {
    allowDisabled: true,
    expectedCwd: nativePluginRoot,
  });
  const resolvedIsNative = resolvedMcp.ok && isNativeCrgMcpConfig(resolvedMcp.config, {
    expectedCwd: nativePluginRoot,
  });
  const nativeDisabled = resolvedLooksNative && !resolvedIsNative;
  const hasGlobalOverride = resolvedMcp.ok && !!resolvedMcp.config && !resolvedLooksNative;
  const legacyOverride = hasGlobalOverride && isPluginManagedLegacyCrgMcpConfig(resolvedMcp.config);
  const ambiguousUvxOverride = hasGlobalOverride && isLegacyUvxCrgMcpConfig(resolvedMcp.config);
  const graphDir = root ? path.join(root, '.code-review-graph') : null;
  const graphExists = !!graphDir && fs.existsSync(graphDir);
  let graphStatus = 'MISSING_OR_EXPLICIT_FAILURE';
  let graphStatusReason = graphExists ? 'Graph status has not passed verification' : 'Graph directory not found';
  let graphStatusErrorCode = null;
  if (runtimeOk && root && graphExists) {
    let status;
    try {
      status = spawnSync(managed.command, ['status'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
        windowsHide: process.platform === 'win32',
      });
    } catch (error) {
      status = { status: null, error, stdout: '', stderr: '' };
    }
    const statusErrorCode = status && status.error && status.error.code;
    graphStatusErrorCode = statusErrorCode || null;
    if (status && !status.error && status.status === 0 && !status.signal) {
      graphStatus = 'PASS';
      graphStatusReason = 'status check passed';
    } else if (statusErrorCode === 'ETIMEDOUT') {
      graphStatus = 'TIMEOUT';
      graphStatusReason = 'CRG status check timed out; status temporarily unavailable';
    } else if (status && status.error) {
      graphStatus = 'STATUS_ERROR';
      graphStatusReason = `CRG status execution error (${statusErrorCode || 'UNKNOWN'})`;
    } else if (!status || status.status == null || status.signal) {
      graphStatus = 'UNAVAILABLE';
      graphStatusReason = 'CRG status temporarily unavailable; retry later';
    } else {
      graphStatus = 'MISSING_OR_EXPLICIT_FAILURE';
      graphStatusReason = `CRG status failed (exit code ${status.status})`;
    }
  }

  log('CodeMap Boost doctor (read-only diagnostics)');
  log(`Plugin version:          ${packageJson.version}`);
  log(`Node.js:           ${nodeStatus.ok ? 'PASS' : 'FAIL'}  ${nodeStatus.version} (requires ${nodeStatus.requirement})`);
  log(`Codex CLI:         ${codexOk ? 'PASS' : 'WARN'}  ${codexPath || 'Standalone CLI executable not found'}${versionText ? ` (${versionText})` : ''}`);
  log(`CODEX_HOME:        ${home}`);
  log(`Plugin data:      ${data}`);
  log(`Private runtime:        ${runtimeOk ? 'PASS' : 'FAIL'}  ${managed.command}`);
  if (!runtimeOk && runtimeDiagnostics.length > 0) log(`Runtime diagnostics:        ${runtimeDiagnostics.slice(-2).join('; ')}`);
  log(`Refresh adapter:        ${refreshAdapter.ok ? 'PASS' : 'FAIL'}  ${refreshAdapter.reason}`);
  log(`Native MCP config:      ${nativeMcp.ok ? 'PASS' : 'FAIL'}  ${nativeMcp.ok ? `Startup timeout ${nativeMcp.config.startup_timeout_sec} seconds` : nativeMcp.diagnostic || 'Missing or invalid declaration'}`);
  log(`Codex MCP resolution:    ${!codexOk ? 'UNKNOWN' : resolvedIsNative ? 'PASS' : 'FAIL'}  ${!codexOk
    ? 'Standalone CLI unavailable; effective configuration cannot be read. Plugin startup does not require the CLI'
    : resolvedIsNative
      ? 'Resolved the native plugin launcher'
    : nativeDisabled
      ? 'Native plugin MCP is disabled'
      : hasGlobalOverride
        ? 'Same-name configuration overrides the native plugin MCP'
        : 'codex mcp get did not return the native plugin MCP'}`);
  log(`Global name override:      ${!codexOk ? 'UNKNOWN' : hasGlobalOverride ? 'FAIL' : 'PASS'}  ${!codexOk
    ? 'Standalone CLI unavailable; legacy override check skipped'
    : hasGlobalOverride
      ? legacyOverride
      ? 'Legacy private-runtime registration shadows native MCP; setup can remove it automatically'
      : ambiguousUvxOverride
        ? 'Found a legacy same-name uvx configuration with unconfirmed ownership; user confirmation is required before removal'
        : 'A custom same-name MCP shadows the native plugin MCP; the user decides whether to keep or remove it'
    : 'No shadowing configuration found'}`);
  log(`Target Git repository:     ${root ? `PASS  ${root}` : 'WARN  Current directory is outside a Git repository'}`);
  log(`Project graph:          ${graphStatus}  ${graphStatusReason}`);
  log(`CRG status:        ${graphStatus}`);
  log('Current task tools: UNKNOWN  CLI cannot read an active task tool snapshot; verify mcp__code_review_graph__ tools in a new task.');

  const needsRepair = !nodeStatus.ok || !runtimeOk || !refreshAdapter.ok || !nativeMcp.ok || (codexOk && !resolvedIsNative) || graphStatus === 'STATUS_ERROR';
  const needsProject = !root;
  const needsRetry = !!root && (graphStatus === 'TIMEOUT' || graphStatus === 'UNAVAILABLE');
  const needsBuild = !!root && graphStatus === 'MISSING_OR_EXPLICIT_FAILURE';
  log('Recommendations:');
  if (!nodeStatus.ok) log(`  - Install Node.js ${nodeStatus.requirement} and ensure the Codex desktop host can resolve node directly; the plugin does not guess Homebrew or nvm paths.`);
  if (!codexOk) log('  - Standalone Codex CLI unavailable; optional effective-MCP and legacy-override checks were skipped. Native plugin MCP does not require the CLI.');
  if (needsProject) log('  - Switch to the target Git repository and rerun --doctor; do not build project graphs in plugin or non-Git directories.');
  if (!nativeMcp.ok) log('  - Native plugin MCP declaration is damaged; update or reinstall codemap-boost-codex.');
  if (nativeDisabled) log('  - Re-enable code-review-graph MCP in Codex plugin settings.');
  else if (!resolvedMcp.ok && codexOk) log('  - Codex did not resolve the native plugin MCP; update or reinstall the plugin and create a new task.');
  if (legacyOverride) log(`  - Automatically remove the legacy global override: node "${path.join(__dirname, 'setup.cjs')}" --build`);
  else if (hasGlobalOverride) log('  - Inspect `codex mcp get code-review-graph --json`; confirm ownership before renaming or removing a same-name MCP.');
  if (!runtimeOk && codexOk) log(`  - Rebuild the private runtime in the target repository: node "${path.join(__dirname, 'setup.cjs')}" --build`);
  else if (!refreshAdapter.ok) log('  - Refresh adapter and private CRG runtime are incompatible; synchronize them and retry --doctor. Do not rebuild the project graph on this evidence.');
  else if (graphStatus === 'STATUS_ERROR') log(`  - CRG status failed (${graphStatusErrorCode || 'UNKNOWN'}); repair the runtime error before retrying. Do not rebuild the graph on this evidence.`);
  else if (needsRetry) log(`  - CRG status ${graphStatus === 'TIMEOUT' ? 'timed out' : 'is temporarily unavailable'}; retry --doctor later. Do not rebuild the graph on this evidence.`);
  else if (codexOk && runtimeOk && refreshAdapter.ok && nativeMcp.ok && needsBuild) log(`  - MCP is ready; run: node "${path.join(__dirname, 'setup.cjs')}" --build`);
  if (needsRepair) log('  - After repair, fully quit Codex and create a new task; existing tasks do not dynamically load additional MCP tools.');
  else log('  - Native MCP is healthy; if graph tools are absent, fully restart Codex and create a new task.');
  const finalStatus = needsRepair
    ? 'NEEDS_REPAIR'
    : needsProject
      ? 'NEEDS_PROJECT'
      : needsRetry
        ? 'RETRY_STATUS'
        : needsBuild
          ? 'NEEDS_BUILD'
          : 'READY';
  log(`Final status:          ${finalStatus}`);
  process.exitCode = finalStatus === 'READY' ? 0 : 1;
}

function main() {
  if (args.has('--help') || args.has('-h')) {
    usage();
    return;
  }

  if (args.has('--doctor')) {
    const incompatible = [...args].filter((arg) => arg !== '--doctor');
    if (incompatible.length > 0) {
      warn(`[codemap-boost-codex] --doctor cannot be combined with ${incompatible.join(', ')}; diagnostic mode must remain read-only.`);
      process.exitCode = 2;
      return;
    }
    runDoctor(process.cwd());
    return;
  }

  const nodeStatus = nodeRuntimeStatus();
  if (!nodeStatus.ok) {
    warn(`[codemap-boost-codex] Node.js ${nodeStatus.version || 'unknown'} is unsupported; requires ${nodeStatus.requirement}.`);
    process.exitCode = 2;
    return;
  }

  log(`[codemap-boost-codex] plugin data: ${pluginDataDir()}`);

  removeMarker('.crg-install-failed');
  removeMarker('.crg-codex-register-failed');
  removeMarker('.codemap-bootstrap-failed');
  if (args.has('--with-graphify')) removeMarker('.graphify-install-failed');

  const crgOk = args.has('--skip-install')
    ? (process.env.CODEMAP_BOOST_ASSUME_CRG === '1' || ensureCrg({ installRuntime: () => false }))
    : ensureCrg();
  if (!crgOk) {
    warn('[codemap-boost-codex] Private code-review-graph runtime unavailable or parser health check failed.');
    warn('[codemap-boost-codex] Do not repair with pip --user; rerun setup to rebuild the isolated environment.');
    process.exit(1);
  }
  log(`[codemap-boost-codex] managed runtime: ${crgRuntimePaths().command}`);

  const migration = removeLegacyCrgMcp({ cwd: process.cwd() });
  if (!migration.ok) {
    warn(`[codemap-boost-codex] ${migration.diagnostic}`);
    process.exitCode = 1;
    return;
  }
  if (migration.changed) {
    log('[codemap-boost-codex] Removed the legacy global MCP override; new tasks load the native plugin code-review-graph MCP.');
  } else if (migration.skipped) {
    log('[codemap-boost-codex] Standalone Codex CLI executable not found; legacy global MCP overrides cannot be checked. Native plugin MCP startup does not require the CLI.');
  }

  if (args.has('--with-graphify') && !ensureGraphify()) {
    warn('[codemap-boost-codex] optional graphify setup failed; CodeMap Boost will continue without graphify.');
  }

  enableCodeMap();
  cleanLegacyCrgHooks();
  cleanLegacyCrgGitHook(process.cwd());
  ensureAgentsBlock();
  ensureGitignore(process.cwd());

  if (args.has('--build')) {
    if (startCrgBuild(process.cwd())) {
      log('[codemap-boost-codex] initial graph build started in the background.');
    } else {
      log('[codemap-boost-codex] initial graph build was skipped; graph may already exist or this is not a Git repo.');
    }
  }

  log(`[codemap-boost-codex] enabled marker: ${path.basename(markerPath(ENABLED_MARKER))}`);
  if (isCodeMapEnabled()) log('[codemap-boost-codex] setup complete.');
}

main();
