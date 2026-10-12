'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { MCP_BOOTSTRAP_BUDGET_MS, crgRuntimePaths, ensureCrg, probeCrgRuntime } = require('./bootstrap');

const {
  codexHome,
  ensureDir,
  gitPath,
  markerPath,
  repoRoot,
  spawnDetached,
  writeMarker,
} = require('./runtime');
const { acquireLockSync, releaseLock, tryAcquireLock } = require('./lock');
const { parseMcpJson, isNativeCrgMcpConfig, resolveCodexCommand, runCodexMcp } = require('./codex-cli');
const {
  LEGACY_MCP_CHECKED_MARKER,
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  isLegacyUvxCrgMcpConfig,
  isPluginManagedLegacyCrgMcpConfig,
  removeLegacyCrgMcp,
  removeLegacyCrgMcpOnce,
} = require('./legacy-crg');

const ENABLED_MARKER = '.codemap-boost-enabled';
const BOOTSTRAP_FAILED_MARKER = '.codemap-bootstrap-failed';
const LOCK_BOOT_MS = 5000;
const LOCK_STALE_MS = 4 * 60 * 60 * 1000;
const REFRESH_LOCK_WAIT_MS = 2 * 60 * 1000;
const REFRESH_WAIT_MS = 10 * 60 * 1000;
const REFRESH_DIAGNOSTIC_MAX_CHARS = 600;
const SOURCE_STATE_FILE = '.codemap-boost-source-state';
const SOURCE_STATE_VERSION = 'verified-graph-v4';
const BLOCK_START = '<!-- codemap-boost-codex:start -->';
const BLOCK_END = '<!-- codemap-boost-codex:end -->';
const GUIDANCE = [
  '1. Tools and target: For code structure, discover code-review-graph and Serena separately in the current tool catalog and deferred discovery. Pass the real target Git worktree as repo_root to graph tools. Before using Serena, activate and confirm the real target project by absolute path. Neither the session cwd nor the plugin directory is the target project.',
  '2. Text and fallback: Read known files directly. For literal text, logs, configuration keys, or filename lists, verify the tgrep-search-codex CLI entry and run it with the target directory as workdir; use live rg when it is not ready. A missing tool is unavailable only for now: fall back immediately and rediscover on a later turn or natural demand. Do not busy-wait or cache permanent absence.',
  '3. Evidence and refresh: Use graph queries for relationships and impact, Serena/LSP for precise symbols, and tgrep/rg for text. Combine only as needed and stop when evidence is sufficient. Graphs apply only to Git worktrees, each with its own graph. Hooks own refresh and the pre-read barrier; update manually only after failure or for setup/diagnosis. A text match does not prove a relationship, and zero matches do not prove absence.',
].join('\n');

// Codex has no uninstall hook, so the block names its owner and tells the agent to ignore it once the plugin is gone.
const AGENTS_OWNER_NOTE = 'Managed by the codemap-boost-codex plugin; remove with `node scripts/setup.cjs --uninstall`. If that plugin is no longer installed, ignore this section.';
const AGENTS_BLOCK = `${BLOCK_START}
## CodeMap Boost

${AGENTS_OWNER_NOTE}

${GUIDANCE}

${BLOCK_END}
`;

function agentsPath(home = codexHome()) {
  return path.join(home, 'AGENTS.md');
}

/**
 * Locate the single managed block; return null when absent and false when markers are ambiguous.
 * Incomplete, reversed, or duplicated markers are never guessed over user rules.
 */
function managedBlockSpan(existing) {
  const start = existing.indexOf(BLOCK_START);
  const endMarker = existing.indexOf(BLOCK_END);
  if (start === -1 && endMarker === -1) return null;
  if (start === -1 || endMarker < start
    || existing.indexOf(BLOCK_START, start + BLOCK_START.length) !== -1
    || existing.indexOf(BLOCK_END, endMarker + BLOCK_END.length) !== -1) return false;
  return { start, end: endMarker + BLOCK_END.length };
}

/**
 * Replace a file through a sibling temporary file so concurrent sessions never observe a partial write.
 * A symlinked file (dotfile managers) is updated at its real location so the link survives, and the
 * existing permissions are kept.
 */
function writeFileAtomic(target, content) {
  let real = target;
  try { real = fs.realpathSync(target); } catch (_) {}
  ensureDir(path.dirname(real));
  const temporary = `${real}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    try { fs.chmodSync(temporary, fs.statSync(real).mode & 0o777); } catch (_) {}
    fs.renameSync(temporary, real);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function readAgents(target) {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? '' : null;
  }
}

function ensureAgentsBlock(home = codexHome()) {
  const target = agentsPath(home);
  const existing = readAgents(target);
  if (existing === null) return false;
  const span = managedBlockSpan(existing);
  if (span === false) return false;
  let next = '';
  if (span) {
    next = existing.slice(0, span.start) + AGENTS_BLOCK.trimEnd() + existing.slice(span.end);
  } else {
    next = existing.replace(/\s+$/, '');
    next += (next ? '\n\n' : '') + AGENTS_BLOCK.trimEnd() + '\n';
  }
  if (next === existing) return true;
  writeFileAtomic(target, next);
  return true;
}

/**
 * Remove the managed block and the blank separator inserted before it; user text is preserved byte for byte.
 * @example removeAgentsBlock() // during `setup.cjs --uninstall`
 */
function removeAgentsBlock(home = codexHome()) {
  const target = agentsPath(home);
  const existing = readAgents(target);
  if (existing === null) return false;
  const span = managedBlockSpan(existing);
  if (span === false) return false;
  if (!span) return true;
  const before = existing.slice(0, span.start).replace(/(?:\r?\n){1,2}$/, '');
  const after = existing.slice(span.end).replace(/^\r?\n/, '');
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const next = before ? `${before}${eol}${after}` : after;
  if (next.trim() === '') {
    // A file that only held the managed block goes away; a symlink is emptied so the linked file is not orphaned.
    if (fs.lstatSync(target).isSymbolicLink()) writeFileAtomic(target, '');
    else fs.rmSync(target, { force: true });
    return true;
  }
  writeFileAtomic(target, next);
  return true;
}

function ensureGitignore(cwd) {
  const root = repoRoot(cwd);
  if (!root) return false;
  const target = path.join(root, '.gitignore');
  let content = '';
  try {
    content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  } catch (_) {
    return false;
  }
  const entries = ['.code-review-graph/', 'graphify-out/'];
  const missing = entries.filter((entry) => !content.split(/\r?\n/).includes(entry));
  if (missing.length === 0) return true;
  let append = content && !content.endsWith('\n') ? '\n' : '';
  append += '# CodeMap generated output\n';
  append += missing.join('\n') + '\n';
  fs.appendFileSync(target, append, 'utf8');
  return true;
}

function ensureGitInfoExclude(cwd) {
  const root = repoRoot(cwd);
  if (!root) return false;
  const target = gitPath(root, 'info/exclude');
  if (!target) return false;
  let content = '';
  try {
    content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  } catch (_) {
    return false;
  }
  const entries = ['.code-review-graph/', 'graphify-out/'];
  const missing = entries.filter((entry) => !content.split(/\r?\n/).includes(entry));
  if (missing.length === 0) return true;
  let append = content && !content.endsWith('\n') ? '\n' : '';
  append += '# CodeMap generated output\n';
  append += missing.join('\n') + '\n';
  try {
    ensureDir(path.dirname(target));
    fs.appendFileSync(target, append, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function crgCommand(options = {}) {
  if (typeof options.crgCommand === 'function') return options.crgCommand();
  if (typeof options.crgCommand === 'string' && options.crgCommand) return options.crgCommand;
  return crgRuntimePaths(options).command;
}

function canUseCrg(options = {}) {
  if (process.env.CODEMAP_BOOST_ASSUME_CRG === '1') return true;
  return probeCrgRuntime(options);
}

function isCodeMapEnabled() {
  // The reminder entry point only checks session policy; runtime health belongs to actual pre-read preparation.
  return process.env.CODEMAP_BOOST_DISABLE_GRAPH !== '1';
}

function enableCodeMap() {
  writeMarker(ENABLED_MARKER);
  return true;
}

function lockName(prefix, cwd) {
  const key = crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return `${prefix}-${key}.lock`;
}

function refreshDiagnosticText(value) {
  const text = String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= REFRESH_DIAGNOSTIC_MAX_CHARS) return text;
  return `${text.slice(0, REFRESH_DIAGNOSTIC_MAX_CHARS - 3)}...`;
}

/**
 * Record a bounded summary of one refresh failure; callers of the Boolean API may pass a diagnostics array.
 * Extract only explicit error text; do not serialize child-process results, command arguments, or environment variables.
 */
function recordRefreshDiagnostic(options, code, detail) {
  if (!Array.isArray(options.diagnostics)) return;
  const message = refreshDiagnosticText(detail) || 'No error detail was reported.';
  options.diagnostics.push({ code, message });
}

function refreshFailed(options, code, detail) {
  recordRefreshDiagnostic(options, code, detail);
  return false;
}

function refreshProcessFailure(result) {
  if (result && result.error) {
    const error = result.error;
    const code = error && error.code ? ` (${error.code})` : '';
    return `Unable to start or complete the refresh process${code}: ${error && error.message ? error.message : error}`;
  }
  const stderr = result && refreshDiagnosticText(result.stderr);
  if (stderr) return stderr;
  const status = result && result.status;
  const signal = result && result.signal;
  if (signal) return `Refresh process terminated by signal ${signal}.`;
  return `Refresh process exited with status ${status === null || status === undefined ? 'unknown' : status}.`;
}

function gitResult(cwd, args, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const timeout = remainingRefreshBudget(options, options.timeout || 30000);
  if (timeout <= 0) return { status: null, error: new Error('Graph preparation budget exhausted'), stdout: '', stderr: '' };
  try {
    return spawn('git', args, {
      cwd,
      env: options.env || process.env,
      encoding: 'utf8',
      stdio: options.stdio || ['ignore', 'pipe', 'ignore'],
      windowsHide: process.platform === 'win32',
      timeout,
    });
  } catch (error) {
    return { status: null, error, stdout: '', stderr: '' };
  }
}

function untrackedFiles(root, options = {}) {
  const result = gitResult(root, ['ls-files', '--others', '--exclude-standard', '-z'], options);
  if (result.error || result.status !== 0) return [];
  return String(result.stdout || '')
    .split('\0')
    .filter(Boolean);
}

function sourceStateFingerprint(root, options = {}) {
  const head = gitResult(root, ['rev-parse', '--verify', 'HEAD'], options);
  const branch = gitResult(root, ['rev-parse', '--abbrev-ref', 'HEAD'], options);
  const status = gitResult(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options);
  if (head.error || head.status !== 0 || branch.error || branch.status !== 0
    || status.error || status.status !== 0) return null;
  const rawStatus = String(status.stdout || '');
  const hash = crypto.createHash('sha256');
  // A v2 full rebuild removes old path aliases; legacy success markers must also pass adapter revalidation once.
  hash.update('verified-graph-v2\0');
  hash.update(String(head.stdout || '').trim());
  hash.update('\0');
  hash.update(String(branch.stdout || '').trim());
  hash.update('\0');
  hash.update(rawStatus);
  for (const entry of rawStatus.split('\0').filter(Boolean)) {
    const relative = /^[ MADRCU?!]{2} /.test(entry) ? entry.slice(3) : entry;
    const target = path.join(root, relative);
    hash.update('\0');
    hash.update(relative);
    try {
      // Do not maintain a duplicate, incomplete language allowlist beside CRG; read in chunks to bound memory for large files.
      if (!fs.lstatSync(target).isFile()) continue;
      const fd = fs.openSync(target, 'r');
      try {
        const buffer = Buffer.alloc(64 * 1024);
        let size;
        while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          if (remainingRefreshBudget(options) <= 0) return null;
          hash.update(buffer.subarray(0, size));
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (_) {
      hash.update('<missing>');
    }
  }
  return hash.digest('hex');
}

function sourceStatePath(root) {
  return path.join(root, '.code-review-graph', SOURCE_STATE_FILE);
}

function runtimeState(command) {
  const resolved = path.resolve(command);
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    return realpath(resolved);
  } catch (_) {
    // During candidate switching or tests, the command may not exist yet; its absolute executable path remains a stable identity.
    return resolved;
  }
}

function fileStatStamp(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile()) return 'not-file';
    return ['file', stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
      .map(String).join(':');
  } catch (error) {
    return error && error.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

function walStateStamp(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    // SQLite may repeatedly create a zero-byte WAL while opening or closing a graph; that does not indicate changed graph content,
    // so treat it like a missing WAL to avoid repeated verification on ordinary MCP reads.
    if (stat.isFile() && stat.size === 0n) return 'empty-or-missing';
  } catch (error) {
    if (error && error.code === 'ENOENT') return 'empty-or-missing';
  }
  return fileStatStamp(filePath);
}

function graphStateStamp(root) {
  const graphDb = path.join(root, '.code-review-graph', 'graph.db');
  const database = fileStatStamp(graphDb);
  // A success marker cannot validate a missing main database; return to the adapter after database deletion.
  if (!database.startsWith('file:')) return null;
  return { database, wal: walStateStamp(`${graphDb}-wal`) };
}

function readSourceState(root) {
  try {
    const state = JSON.parse(fs.readFileSync(sourceStatePath(root), 'utf8'));
    return state && state.version === SOURCE_STATE_VERSION ? state : null;
  } catch (_) {
    return null;
  }
}

function writeSourceState(root, state) {
  if (!state || state.version !== SOURCE_STATE_VERSION) return;
  try {
    fs.writeFileSync(sourceStatePath(root), `${JSON.stringify(state)}\n`, 'utf8');
  } catch (_) {}
}

function sourceStateMatches(state, source, runtime, graph) {
  return !!state && state.source === source && state.runtime === runtime
    && state.graph && state.graph.database === graph.database && state.graph.wal === graph.wal;
}

function withTemporaryGitIndex(root, callback, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-git-index-'));
  const indexFile = path.join(tempDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    const head = gitResult(root, ['rev-parse', '--verify', 'HEAD'], options);
    const readTreeArgs = !head.error && head.status === 0 ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'];
    const readTree = gitResult(root, readTreeArgs, { ...options, env });
    if (readTree.error || readTree.status !== 0) return false;
    const add = gitResult(root, ['add', '-A', '--', '.'], { ...options, env, timeout: 120000 });
    if (add.error || add.status !== 0) return false;
    return callback(env);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function runCrgDefault(args, options = {}) {
  const command = crgCommand(options);
  const python = path.join(path.dirname(command), process.platform === 'win32' ? 'python.exe' : 'python');
  const adapter = path.resolve(__dirname, '../../../scripts/refresh_graph.py');
  const common = {
    cwd: options.cwd,
    env: options.env || process.env,
    // Successful results go to stdout; retain only stderr here so the read barrier can report a real bounded failure summary.
    stdio: options.stdio || ['ignore', 'ignore', 'pipe'],
    encoding: options.encoding || 'utf8',
    maxBuffer: options.maxBuffer || 64 * 1024,
    windowsHide: process.platform === 'win32',
    timeout: options.timeout || REFRESH_WAIT_MS,
  };
  return spawnSync(python, ['-I', '-B', adapter, ...args], common);
}

function refreshCrgUnlocked(root, options = {}) {
  root = repoRoot(root);
  if (!root) return refreshFailed(options, 'refresh_execution_failed', 'The target is not a Git working tree.');
  ensureGitInfoExclude(root);
  const hasGraph = fs.existsSync(path.join(root, '.code-review-graph'));
  const sourceState = sourceStateFingerprint(root, options);
  if (!sourceState) {
    return refreshFailed(options, 'refresh_execution_failed', 'Unable to read a stable Git source state before refresh.');
  }
  const command = crgCommand(options);
  const runtime = runtimeState(command);
  const graph = graphStateStamp(root);
  const previous = readSourceState(root);
  if (hasGraph && graph && sourceStateMatches(previous, sourceState, runtime, graph)) return true;
  // Embedding tools write the same SQLite/WAL. Still let the adapter validate business graph content,
  // rather than treating legitimate vector writes as source changes and clearing the graph.
  const verifyGraphOnly = hasGraph && graph && previous
    && previous.source === sourceState && previous.runtime === runtime;
  // Let CRG filter the worktree so JavaScript does not omit supported file types.
  const hasUntrackedSource = untrackedFiles(root, options).length > 0;
  const action = verifyGraphOnly ? 'verify' : (hasGraph && !hasUntrackedSource ? 'update' : 'build');
  const args = [action, '--repo', root];
  const runCrg = options.runCrg || runCrgDefault;
  const invoke = (env) => {
    const timeout = remainingRefreshBudget(options, options.timeout || REFRESH_WAIT_MS);
    if (timeout <= 0) return refreshFailed(options, 'prepare_budget_exhausted', 'The graph preparation budget was exhausted before refresh.');
    try {
      fs.rmSync(sourceStatePath(root), { force: true });
    } catch (error) {
      return refreshFailed(options, 'refresh_execution_failed', `Unable to invalidate the old source marker: ${error.message}`);
    }
    let result;
    try {
      result = runCrg(args, {
        cwd: root,
        env,
        crgCommand: command,
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout,
      });
    } catch (error) {
      return refreshFailed(options, 'refresh_process_failed', `Refresh process threw an exception: ${error.message}`);
    }
    if (!result || result.error || result.status !== 0) {
      return refreshFailed(options, 'refresh_process_failed', refreshProcessFailure(result));
    }
    if (sourceStateFingerprint(root, options) !== sourceState) {
      return refreshFailed(
        options,
        'refresh_source_changed',
        'The repository source state changed while the graph refresh was running.'
      );
    }
    if (runtimeState(crgCommand(options)) !== runtime) {
      return refreshFailed(
        options,
        'refresh_runtime_changed',
        'The selected CRG runtime changed while the graph refresh was running.'
      );
    }
    const refreshedGraph = graphStateStamp(root);
    if (!refreshedGraph) {
      return refreshFailed(
        options,
        'refresh_graph_missing',
        'The graph database is missing after a successful refresh.'
      );
    }
    writeSourceState(root, {
      version: SOURCE_STATE_VERSION,
      source: sourceState,
      runtime,
      graph: refreshedGraph,
    });
    return true;
  };
  if (!hasUntrackedSource) return invoke(process.env);
  const diagnosticCount = Array.isArray(options.diagnostics) ? options.diagnostics.length : 0;
  const ok = withTemporaryGitIndex(root, invoke, options);
  if (ok || (Array.isArray(options.diagnostics) && options.diagnostics.length > diagnosticCount)) return ok;
  return refreshFailed(options, 'refresh_execution_failed', 'Unable to prepare the temporary Git index for a full graph build.');
}

function refreshCrgSync(cwd, options = {}) {
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') {
    return refreshFailed(options, 'refresh_execution_failed', 'Graph support is disabled for this session.');
  }
  const root = repoRoot(cwd);
  if (!root) return refreshFailed(options, 'refresh_execution_failed', 'The target is not a Git working tree.');
  const canUse = options.canUseCrg || canUseCrg;
  if (!canUse()) return refreshFailed(options, 'refresh_execution_failed', 'The managed code-review-graph runtime is not ready.');
  const lockFile = path.join(os.tmpdir(), lockName('codemap-crg-refresh', root));
  const waitMs = remainingRefreshBudget(options, options.waitMs ?? REFRESH_LOCK_WAIT_MS);
  if (remainingRefreshBudget(options) <= 0) {
    return refreshFailed(options, 'prepare_budget_exhausted', 'The graph preparation budget was exhausted before acquiring the refresh lock.');
  }
  const lockToken = acquireLockSync(lockFile, { waitMs, pollMs: 50, bootMs: LOCK_BOOT_MS, staleMs: LOCK_STALE_MS });
  if (!lockToken) {
    return refreshFailed(options, 'lock_wait_timeout', `Refresh lock wait timed out after ${waitMs} ms.`);
  }
  try {
    return refreshCrgUnlocked(root, options);
  } finally {
    releaseLock(lockFile, lockToken);
  }
}

function remainingRefreshBudget(options, requestedMs = Infinity) {
  if (!Number.isFinite(options.deadlineMs)) return requestedMs;
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  return Math.max(0, Math.min(requestedMs, options.deadlineMs - now));
}

/**
 * Synchronously repair the runtime and refresh the target worktree only on an actual graph-tool read.
 * Installation, lock wait, Git status collection, and refresh share a deadline; leave 30 seconds of the 600-second hook for returning.
 * Freeze the runtime snapshot so preparation and graph provenance use the same exact version and executable path.
 */
function prepareCrgForRead(cwd, options = {}) {
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') {
    return refreshFailed(options, 'runtime_prepare_failed', 'Graph support is disabled for this session.');
  }
  const root = repoRoot(cwd);
  if (!root) return refreshFailed(options, 'runtime_prepare_failed', 'The target is not a Git working tree.');
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const deadlineMs = Math.min(options.deadlineMs ?? Infinity, now + MCP_BOOTSTRAP_BUDGET_MS);
  if (deadlineMs <= now) return refreshFailed(options, 'prepare_budget_exhausted', 'The graph preparation budget was exhausted before runtime preparation.');
  // The catalog helper only reads the active pointer and installation metadata; it starts neither CRG nor an interpreter.
  const { recordSelectedCrgRuntime, selectCrgRuntime } = require('../../../scripts/mcp-catalog.cjs');
  const runtimeOptions = selectCrgRuntime({ ...options, deadlineMs });
  const paths = crgRuntimePaths(runtimeOptions);
  const diagnostics = [];
  const ensure = options.ensureCrg || ensureCrg;
  if (!ensure({ ...runtimeOptions, diagnostics })) {
    return refreshFailed(options, 'runtime_prepare_failed', diagnostics.slice(-3).join('; ')
      || 'The managed code-review-graph runtime could not be prepared within the graph call budget. Run setup for diagnostics, or retry the graph call.');
  }
  recordSelectedCrgRuntime(runtimeOptions);
  return refreshCrgSync(root, {
    ...options, deadlineMs, crgCommand: paths.command,
    // ensureCrg has validated this frozen snapshot; avoid a duplicate probe that rereads the active pointer.
    canUseCrg: () => true,
  });
}

function startCrgBuild(cwd, options = {}) {
  if (process.env.CODEMAP_BOOST_DISABLE_BACKGROUND === '1') return false;
  const root = repoRoot(cwd);
  if (!root) return false;
  const enabled = options.isCodeMapEnabled || (() => isCodeMapEnabled() && canUseCrg());
  if (!enabled()) return false;
  const graphDir = path.join(root, '.code-review-graph');
  if (fs.existsSync(graphDir)) return false;
  const lockFile = path.join(os.tmpdir(), lockName('codemap-crg-refresh', root));
  const lockToken = tryAcquireLock(lockFile, { bootMs: LOCK_BOOT_MS, staleMs: LOCK_STALE_MS });
  if (!lockToken) return false;
  const command = crgCommand(options);
  const code = `
    const lock = require(${JSON.stringify(path.join(__dirname, 'lock.js'))});
    const codemap = require(${JSON.stringify(__filename)});
    try {
      lock.transferLock(${JSON.stringify(lockFile)}, ${JSON.stringify(lockToken)}, process.pid);
      codemap.refreshCrgUnlocked(${JSON.stringify(root)}, { crgCommand: ${JSON.stringify(command)} });
    } finally {
      lock.releaseLock(${JSON.stringify(lockFile)}, ${JSON.stringify(lockToken)});
    }
  `;
  const launch = options.spawnDetached || spawnDetached;
  const child = launch(process.execPath, ['-e', code], { cwd: root });
  if (!child) {
    releaseLock(lockFile, lockToken);
    return false;
  }
  return true;
}

function readBootstrapFailure() {
  for (const name of ['.crg-install-failed', BOOTSTRAP_FAILED_MARKER]) {
    try {
      const diagnostic = fs.readFileSync(markerPath(name), 'utf8').trim();
      if (diagnostic && diagnostic !== '1') return diagnostic;
    } catch (_) {}
  }
  return '';
}

const CONTEXT = GUIDANCE;

function promptLooksStructural(text) {
  const value = String(text || '').toLowerCase();
  return /\b(?:callers?|callees?|dependencies|depends? on|references?|call (?:graph|chain)|impact (?:radius|analysis)|review context|codemap|code map)\b|\u4ee3\u7801\u7ed3\u6784|\u7b26\u53f7\u5173\u7cfb|\u8c03\u7528|\u5f15\u7528\u5173\u7cfb|\u5f71\u54cd\u9762|\u4ee3\u7801\u5ba1\u67e5|\u6a21\u5757\u4f9d\u8d56|\u4f9d\u8d56\u5173\u7cfb|\u4f9d\u8d56\u94fe/.test(value)
    || /\b(?:review|inspect|check)\b.{0,50}\b(?:code|patch|changes?|diff|regressions?)\b/.test(value)
    || /(?:\u5206\u6790|\u68b3\u7406|\u67e5\u627e|\u5b9a\u4f4d|\u4e86\u89e3).{0,30}(?:\u67b6\u6784|\u6a21\u5757|\u7b26\u53f7|\u51fd\u6570|\u7c7b)|(?:find|locate|trace|inspect|explain)\b.{0,40}\b(?:symbols?|functions?|classes|architecture|modules?)\b/.test(value);
}

module.exports = {
  BLOCK_START,
  BLOCK_END,
  AGENTS_BLOCK,
  CONTEXT,
  ENABLED_MARKER,
  LEGACY_MCP_CHECKED_MARKER,
  BOOTSTRAP_FAILED_MARKER,
  agentsPath,
  ensureAgentsBlock,
  removeAgentsBlock,
  ensureGitignore,
  ensureGitInfoExclude,
  crgCommand,
  canUseCrg,
  isCodeMapEnabled,
  enableCodeMap,
  startCrgBuild,
  refreshCrgUnlocked,
  refreshCrgSync,
  prepareCrgForRead,
  parseMcpJson,
  isLegacyUvxCrgMcpConfig,
  isPluginManagedLegacyCrgMcpConfig,
  isNativeCrgMcpConfig,
  resolveCodexCommand,
  runCodexMcp,
  removeLegacyCrgMcp,
  removeLegacyCrgMcpOnce,
  readBootstrapFailure,
  cleanLegacyCrgHooks,
  cleanLegacyCrgGitHook,
  promptLooksStructural,
};
