'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pythonCandidates, resolvePythonCandidates } = require('./python');

const isWindows = process.platform === 'win32';
const ICONV_LITE_SPEC = 'iconv-lite@0.6.3';
const CLANG_FORMAT_SPEC = 'clang-format==18.1.8';
// Plugin root: hooks/js/lib -> hooks/js -> hooks -> plugin root.
// Prefer PLUGIN_ROOT injected by the Codex hook; fall back to relative __dirname when absent (such as direct Node tests).
const PLUGIN_ROOT = process.env.PLUGIN_ROOT || path.join(__dirname, '..', '..', '..');

/**
 * Persistent data directory. Codex hooks inject PLUGIN_DATA at runtime.
 * When absent (for example in direct Node tests), use CODEX_HOME or the user-level Codex data directory.
 */
function pluginDataDir() {
  const d = process.env.PLUGIN_DATA;
  if (d) return d;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'plugins', 'data', 'cpp-style-enforcer-codex');
}

/**
 * Absolute marker path for a prior failed installation that should not be retried.
 * The installation target is PLUGIN_DATA, so the failure marker also belongs there (persistent and writable);
 * fall back to the plugin root when PLUGIN_DATA is absent for legacy compatibility.
 */
function markerPath(name) {
  const dataDir = pluginDataDir();
  return path.join(dataDir || PLUGIN_ROOT, name);
}

/** Safely check whether a marker file exists. */
function markerExists(p) {
  try { return !!p && fs.existsSync(p); } catch (_) { return false; }
}

/** Write a marker safely and silently ignore failure. */
function writeMarker(p) {
  try {
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '1');
  } catch (_) {}
}

/**
 * Install iconv-lite in the persistent PLUGIN_DATA directory rather than the plugin root.
 * Marketplace bundles may strip packaged node_modules, and plugin updates replace the installation directory;
 * the installation may be read-only, while PLUGIN_DATA persists and is writable. If absent, skip installation and return false.
 * Use `npm install <pkg> --prefix <dataDir>` with a dependency name matching package.json.
 */
function npmInstall() {
  const dataDir = pluginDataDir();
  if (!dataDir) return false; // No persistent directory: skip installation without crashing.
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (_) {}
  try {
    const r = spawnSync(
      isWindows ? 'npm.cmd' : 'npm',
      ['install', ICONV_LITE_SPEC, '--no-audit', '--no-fund', '--no-save', '--prefix', dataDir],
      { cwd: dataDir, stdio: 'ignore', timeout: 60000, windowsHide: isWindows }
    );
    return !r.error && r.status === 0;
  } catch (_) {
    return false;
  }
}

/** Default: install clang-format with pip through Python for portability. */
function pipInstallClangFormat() {
  for (const py of resolvePythonCandidates()) {
    try {
      const r = spawnSync(
        py.cmd,
        [...py.args, '-m', 'pip', 'install', '--disable-pip-version-check', CLANG_FORMAT_SPEC],
        { stdio: 'ignore', timeout: 120000, windowsHide: isWindows }
      );
      if (!r.error && r.status === 0) return true;
    } catch (_) {}
  }
  return false;
}

/**
 * Default probe: run `<cmd> [...args] --version` to check a command descriptor.
 * @param {{cmd:string, args:string[]}} desc
 * @returns {boolean}
 */
function probeClangFormat(desc) {
  try {
    const r = spawnSync(desc.cmd, [...desc.args, '--version'], { stdio: 'ignore', timeout: 10000, windowsHide: isWindows });
    return !r.error && r.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * Default: locate absolute clang-format executable candidates in Scripts directories of verified Python 3 launchers.
 * Pip entry scripts often live there without being on PATH; return [] silently on failure.
 * @returns {Array<{cmd:string, args:string[]}>}
 */
function scriptsDirCandidates() {
  const out = [];
  for (const py of resolvePythonCandidates()) {
    let dir = null;
    try {
      const r = spawnSync(py.cmd, [...py.args, '-c', "import sysconfig; print(sysconfig.get_path('scripts'))"],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, windowsHide: isWindows });
      if (!r.error && r.status === 0 && r.stdout) dir = String(r.stdout).trim();
    } catch (_) {}
    if (!dir) continue;
    for (const exe of isWindows ? ['clang-format.exe', 'clang-format'] : ['clang-format']) {
      const p = path.join(dir, exe);
      try { if (fs.existsSync(p)) out.push({ cmd: p, args: [] }); } catch (_) {}
    }
  }
  return out;
}

/**
 * Default: find a usable clang-format invocation in order and return {cmd, args}, or null.
 * Order: (1) clang-format on PATH, (2) pip module entry python -m clang_format (Python 3 only),
 *      (3) clang-format executable in a Python Scripts directory.
 *
 * @param {object} [opts]
 * @param {function({cmd:string,args:string[]}):boolean} [opts.probe] Injected probe function for tests
 * @param {function():Array<{cmd:string,args:string[]}>} [opts.scriptsDirs] Injected Scripts candidate generator for tests
 * @param {function():Array<{cmd:string,args:string[]}>} [opts.pythons] Injected verified Python 3 candidates for tests
 * @returns {{cmd:string, args:string[]}|null}
 */
function detectClangFormat(opts) {
  const o = opts || {};
  const probe = o.probe || probeClangFormat;
  const scriptsDirs = o.scriptsDirs || scriptsDirCandidates;
  const pythons = o.pythons || resolvePythonCandidates;

  const candidates = [
    { cmd: 'clang-format', args: [] },
    ...pythons().map((py) => ({ cmd: py.cmd, args: [...py.args, '-m', 'clang_format'] })),
  ];
  for (const desc of candidates) {
    try { if (probe(desc)) return desc; } catch (_) {}
  }
  let extra = [];
  try { extra = scriptsDirs() || []; } catch (_) { extra = []; }
  for (const desc of extra) {
    try { if (probe(desc)) return desc; } catch (_) {}
  }
  return null;
}

/**
 * Resolve a module entry path from both locations, returning null if absent.
 * Order: (a) ${PLUGIN_ROOT}/node_modules/<name> (packaged or local/Git installation),
 *      (b) ${PLUGIN_DATA}/node_modules/<name> (fallback installed by SessionStart).
 * Use require.resolve(paths) to search selected directory trees; never throw.
 * @param {string} name Module name
 * @returns {string|null} Resolved entry path
 */
function resolveModulePath(name) {
  const roots = [];
  if (PLUGIN_ROOT) roots.push(PLUGIN_ROOT);
  const dataDir = pluginDataDir();
  if (dataDir) roots.push(dataDir);
  for (const r of roots) {
    try {
      return require.resolve(name, { paths: [r] });
    } catch (_) {}
  }
  return null;
}

let _iconvCache; // undefined=unresolved; null=known unavailable; object=module
/**
 * Resolve iconv-lite from ROOT then DATA without installing it, and cache the result.
 * For frequent bom_util calls: lightweight, starts no subprocess, and returns null for GBK fallback if missing.
 * @returns {object|null}
 */
function requireIconv() {
  if (_iconvCache !== undefined) return _iconvCache;
  const p = resolveModulePath('iconv-lite');
  let mod = null;
  if (p) {
    try { mod = require(p); } catch (_) { mod = null; }
  }
  _iconvCache = mod;
  return mod;
}

/**
 * Resolve iconv-lite; runtime normally only detects it, while explicit allowInstall installs once into PLUGIN_DATA.
 * On failure, write a marker and return null (skip GBK); never throw.
 *
 * Resolution checks both locations: use requireIconv (ROOT then DATA) by default, or resolve an injected moduleName in tests.
 *
 * @param {object} [opts]
 * @param {string} [opts.moduleName] Injected for tests; default uses requireIconv with both locations
 * @param {string} [opts.marker] Failure marker path, defaulting to .iconv-install-failed in PLUGIN_DATA (or the plugin root)
 * @param {boolean} [opts.allowInstall] Explicitly allow installation; do not enable in ordinary hooks
 * @param {function():boolean} [opts.install] Injected installer; defaults to npmInstall into PLUGIN_DATA
 * @returns {object|null}
 */
function ensureIconvLite(opts) {
  const o = opts || {};
  const marker = o.marker || markerPath('.iconv-install-failed');
  const allowInstall = o.allowInstall === true;
  const install = o.install || npmInstall;

  // With an injected moduleName, resolve that name (tests can simulate absence); otherwise check both paths.
  const tryRequire = o.moduleName
    ? () => { try { return require(o.moduleName); } catch (_) { return null; } }
    : () => requireIconv();

  const found = tryRequire();
  if (found) return found;                 // Already installed: do not install.
  if (markerExists(marker)) return null;    // Previous failure: do not retry.
  if (!allowInstall) return null;           // At runtime, detect only; do not install in hooks.

  let ok = false;
  try { ok = !!install(); } catch (_) { ok = false; }
  if (ok) {
    // Clear the cache and resolve again after an installation in PLUGIN_DATA.
    _iconvCache = undefined;
    const after = tryRequire();
    if (after) return after;
  }
  writeMarker(marker);
  return null;
}

/**
 * Resolve clang-format; runtime normally only detects it, while explicit allowInstall installs once with pip.
 * If still absent, write a failure marker and return null (skip clang-format); never throw.
 *
 * @param {object} [opts]
 * @param {function():({cmd:string,args:string[]}|null)} [opts.detect] Injected detector; defaults to detectClangFormat
 * @param {string} [opts.marker] Failure marker path, defaulting to .clang-format-install-failed in plugin root
 * @param {boolean} [opts.allowInstall] Explicitly allow installation; do not enable in ordinary hooks
 * @param {function():boolean} [opts.install] Injected installer; defaults to pipInstallClangFormat
 * @returns {{cmd:string, args:string[]}|null}
 */
function ensureClangFormat(opts) {
  const o = opts || {};
  const marker = o.marker || markerPath('.clang-format-install-failed');
  const detect = o.detect || detectClangFormat;
  const allowInstall = o.allowInstall === true;
  const install = o.install || pipInstallClangFormat;

  let desc = null;
  try { desc = detect(); } catch (_) { desc = null; }
  if (desc) return desc;                      // Already available: do not install.
  if (markerExists(marker)) return null;      // Previous failure: do not retry.
  if (!allowInstall) return null;             // At runtime, detect only; do not install in hooks.

  let ok = false;
  try { ok = !!install(); } catch (_) { ok = false; }
  if (ok) {
    try { desc = detect(); } catch (_) { desc = null; }
    if (desc) return desc;
  }
  writeMarker(marker);
  return null;
}

/**
 * No-op for legacy tests and callers. Passive SessionStart no longer installs dependencies in the background.
 * @returns {null}
 */
function spawnPrewarm() {
  return null;
}

module.exports = {
  ensureIconvLite,
  ensureClangFormat,
  markerPath,
  spawnPrewarm,
  detectClangFormat,
  requireIconv,
  pythonCandidates,
};

// CLI manual warm-up entry point: install/detect only, never emit output.
if (require.main === module && process.argv.includes('--prewarm')) {
  try { ensureIconvLite({ allowInstall: true }); } catch (_) {}
  try { ensureClangFormat({ allowInstall: true }); } catch (_) {}
  process.exit(0);
}
