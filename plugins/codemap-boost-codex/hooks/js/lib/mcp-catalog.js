'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { crgRuntimePaths } = require('./bootstrap');
const { activeRuntimeVersion, isRuntimeVersion, promoteRuntimeVersion } = require('./runtime-versions');
const { pluginDataDir } = require('./runtime');
const { acquireUpdateLock, releaseUpdateLock } = require('./update-lock');

const BUNDLED_CRG_VERSION = '2.3.9';
// The Python exporter and the bundled catalogs ship in the plugin's scripts directory.
const SCRIPTS_DIR = path.join(__dirname, '..', '..', '..', 'scripts');

// Read installation metadata only; do not start interpreters, CLI probes, or models.
function diskRuntimeVersion(runtimeDir) {
  if (!runtimeDir) return '';
  const candidates = [path.join(runtimeDir, 'Lib', 'site-packages')];
  try {
    for (const name of fs.readdirSync(path.join(runtimeDir, 'lib'))) {
      if (/^python\d+\.\d+$/.test(name)) candidates.push(path.join(runtimeDir, 'lib', name, 'site-packages'));
    }
  } catch (_) {}
  for (const directory of candidates) {
    let entries;
    try { entries = fs.readdirSync(directory); } catch (_) { continue; }
    for (const name of entries) {
      if (!/^code_review_graph-[\d.]+\.dist-info$/.test(name)) continue;
      try {
        const metadata = fs.readFileSync(path.join(directory, name, 'METADATA'), 'utf8');
        const result = /^Version:\s*(\S+)\s*$/m.exec(metadata);
        if (result && isRuntimeVersion(result[1])) return result[1];
      } catch (_) {}
    }
  }
  return '';
}

/** Freeze runtime selection. First installation uses the exact version matching the bundled schema. */
function selectCrgRuntime(options = {}) {
  const data = options.pluginDataDir || pluginDataDir(options);
  const version = options.version || activeRuntimeVersion('crg', { ...options, pluginDataDir: data });
  const paths = crgRuntimePaths({ ...options, pluginDataDir: data, version });
  const installed = diskRuntimeVersion(paths.dir);
  const selected = version || installed || BUNDLED_CRG_VERSION;
  const runtimeDir = options.runtimeDir || ((version || installed) ? paths.dir
    : crgRuntimePaths({ ...options, pluginDataDir: data, version: selected }).dir);
  return { ...options, pluginDataDir: data, version: selected, expectedVersion: selected, runtimeDir };
}

/** Publish selection after the first verified versioned install; preserve legacy and existing active selections. */
function recordSelectedCrgRuntime(options = {}) {
  if (!isRuntimeVersion(options.version) || activeRuntimeVersion('crg', options)) return false;
  const expected = crgRuntimePaths({ ...options, runtimeDir: undefined, version: options.version }).dir;
  if (!options.runtimeDir || path.resolve(options.runtimeDir) !== path.resolve(expected)
      || diskRuntimeVersion(options.runtimeDir) !== options.version) return false;
  // The updater writes the same Serena/CRG pointer; share its lock so read-check-write cannot lose the other kind.
  // If the lock is busy, recording is retried on the next preparation.
  const lockOptions = { pluginDataDir: options.pluginDataDir };
  const lock = acquireUpdateLock(lockOptions);
  if (!lock) return false;
  try {
    if (activeRuntimeVersion('crg', options)) return false;
    promoteRuntimeVersion('crg', options.version, options);
    return true;
  } finally { releaseUpdateLock(lock); }
}

function validateCatalog(value, expectedVersion) {
  if (!value || value.format !== 2 || !isRuntimeVersion(value.version)
      || (expectedVersion && value.version !== expectedVersion)
      || typeof value.protocolVersion !== 'string' || !value.serverInfo || !value.capabilities
      || !Array.isArray(value.requestMethods) || !value.requestMethods.every((method) => typeof method === 'string')
      || !Array.isArray(value.tools) || !value.tools.length || !Array.isArray(value.prompts)
      || !Array.isArray(value.resources) || !Array.isArray(value.resourceTemplates)) {
    throw new Error('CRG MCP catalog version or discovery protocol structure does not match');
  }
  for (const tool of value.tools) {
    if (!tool || typeof tool.name !== 'string' || !tool.inputSchema || tool.inputSchema.type !== 'object') {
      throw new Error('Invalid CRG MCP catalog tool schema');
    }
  }
  return value;
}

function catalogPath(version, options = {}) {
  if (!isRuntimeVersion(version)) throw new Error('Invalid catalog version');
  return path.join(options.pluginDataDir || pluginDataDir(options), 'mcp-catalogs', `${version}.json`);
}

function writeCatalog(catalog, options = {}) {
  validateCatalog(catalog, options.expectedVersion);
  const file = catalogPath(catalog.version, options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  try { fs.renameSync(temp, file); } catch (error) { try { fs.rmSync(temp, { force: true }); } catch (_) {} throw error; }
  return catalog;
}

function exportCatalog(paths, expectedVersion, options = {}) {
  const timeout = options.catalogTimeoutMs || 30000;
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, stdout = '', stderr = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => { try { child.kill(); } catch (_) {} finish(new Error('catalog export cancelled')); };
    if (options.signal && options.signal.aborted) return finish(new Error('catalog export cancelled'));
    try {
      child = (options.catalogSpawn || spawn)(paths.python, ['-I', '-B', path.join(SCRIPTS_DIR, 'export-mcp-catalog.py')], {
        cwd: options.pluginDataDir || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, ...(options.env || {}), CRG_TOOLS: '' },
      });
      if (options.signal) options.signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 4 * 1024 * 1024) abort(); });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (code !== 0) return finish(new Error(`catalog export failed (${code}): ${stderr}`));
        try { finish(null, writeCatalog(validateCatalog(JSON.parse(stdout), expectedVersion), options)); } catch (error) { finish(error); }
      });
      timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(new Error('catalog export timeout')); }, timeout);
    } catch (error) { finish(error); }
  });
}

function filteredCatalog(catalog, options = {}) {
  const raw = String((options.env || process.env).CRG_TOOLS || '');
  const names = new Set(raw.split(',').map((name) => name.trim()).filter(Boolean));
  return names.size ? { ...catalog, tools: catalog.tools.filter((tool) => names.has(tool.name)) } : catalog;
}

async function loadCatalog(options = {}) {
  const selected = selectCrgRuntime(options);
  const paths = crgRuntimePaths(selected);
  // A pointer schema must not hide a mismatch with the actual installed version.
  const installed = diskRuntimeVersion(paths.dir);
  const version = selected.version;
  const sources = [catalogPath(version, selected), path.join(SCRIPTS_DIR, `mcp-catalog-${version}.json`)];
  for (const source of sources) {
    try { return filteredCatalog(validateCatalog(JSON.parse(fs.readFileSync(source, 'utf8')), version), options); } catch (_) {}
  }
  if (installed && installed !== selected.version) {
    throw new Error(`CRG runtime pointer/catalog mismatch with no matching catalog: selected ${selected.version}, installed ${installed}; repair the runtime first`);
  }
  return filteredCatalog(await exportCatalog(paths, version, selected), options);
}

module.exports = { BUNDLED_CRG_VERSION, catalogPath, diskRuntimeVersion, exportCatalog, filteredCatalog, loadCatalog, recordSelectedCrgRuntime, selectCrgRuntime, validateCatalog, writeCatalog };
