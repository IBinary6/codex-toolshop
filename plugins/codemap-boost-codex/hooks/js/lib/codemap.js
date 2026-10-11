'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { MCP_STARTUP_TIMEOUT_SEC, MCP_BOOTSTRAP_BUDGET_MS, crgRuntimePaths, ensureCrg, probeCrgRuntime } = require('./bootstrap');

const {
  codexHome,
  ensureDir,
  markerPath,
  repoRoot,
  spawnDetached,
  writeMarker,
} = require('./runtime');

const ENABLED_MARKER = '.codemap-boost-enabled';
const LEGACY_MCP_CHECKED_MARKER = '.legacy-crg-mcp-checked';
const LEGACY_MCP_RETRY_MS = 24 * 60 * 60 * 1000;
const BOOTSTRAP_FAILED_MARKER = '.codemap-bootstrap-failed';
const LOCK_BOOT_MS = 5000;
const LOCK_STALE_MS = 4 * 60 * 60 * 1000;
const BOOTSTRAP_LOCK_STALE_MS = 30 * 60 * 1000;
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
  const next = before && after ? `${before}${eol}${after}` : before ? `${before}${eol}` : after;
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
  let target = '';
  try {
    const result = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: process.platform === 'win32',
      timeout: 5000,
    });
    if (!result.error && result.status === 0) target = result.stdout.trim();
  } catch (_) {}
  if (!target) return false;
  if (!path.isAbsolute(target)) target = path.resolve(root, target);
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

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function isLockActive(file, staleMs = LOCK_STALE_MS) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10) || 0;
    const stat = fs.statSync(file);
    const age = Date.now() - stat.mtimeMs;
    if (age <= LOCK_BOOT_MS) return true;
    if (age <= staleMs && isPidAlive(pid)) return true;
    fs.unlinkSync(file);
  } catch (_) {}
  return false;
}

function tryWriteLock(file) {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch (_) {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function acquireRefreshLock(lockFile, waitMs = REFRESH_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    if (!isLockActive(lockFile) && tryWriteLock(lockFile)) return true;
    sleepSync(50);
  }
  return false;
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
  if (!acquireRefreshLock(lockFile, waitMs)) {
    return refreshFailed(options, 'lock_wait_timeout', `Refresh lock wait timed out after ${waitMs} ms.`);
  }
  try {
    return refreshCrgUnlocked(root, options);
  } finally {
    try { fs.unlinkSync(lockFile); } catch (_) {}
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

function listLinkedWorktrees(cwd) {
  const root = repoRoot(cwd);
  if (!root) return [];
  const result = gitResult(root, ['worktree', 'list', '--porcelain']);
  if (result.error || result.status !== 0) return [root];
  return String(result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => {
      const worktree = path.resolve(line.slice('worktree '.length).trim());
      try {
        const realpath = fs.realpathSync.native || fs.realpathSync;
        return realpath(worktree);
      } catch (_) {
        return worktree;
      }
    })
    .filter((worktree, index, all) => fs.existsSync(worktree) && all.indexOf(worktree) === index);
}

function refreshLinkedWorktreesSync(cwd, options = {}) {
  const worktrees = listLinkedWorktrees(cwd);
  if (worktrees.length === 0) return false;
  let ok = true;
  for (const worktree of worktrees) {
    if (!refreshCrgSync(worktree, options)) ok = false;
  }
  return ok;
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
  if (isLockActive(lockFile)) return false;
  if (!tryWriteLock(lockFile)) return false;
  const command = crgCommand(options);
  const code = `
    const fs = require('fs');
    const codemap = require(${JSON.stringify(__filename)});
    try {
      try { fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid)); } catch (_) {}
      codemap.refreshCrgUnlocked(${JSON.stringify(root)}, { crgCommand: ${JSON.stringify(command)} });
    } finally {
      try { fs.unlinkSync(${JSON.stringify(lockFile)}); } catch (_) {}
    }
  `;
  const launch = options.spawnDetached || spawnDetached;
  const child = launch(process.execPath, ['-e', code], { cwd: root });
  if (!child) {
    try { fs.unlinkSync(lockFile); } catch (_) {}
    return false;
  }
  return true;
}

function writeBootstrapDiagnostic(diagnostic) {
  try {
    const target = markerPath(BOOTSTRAP_FAILED_MARKER);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, `${diagnostic}\n`, 'utf8');
  } catch (_) {}
}

/**
 * Explicit setup/repair may start background runtime repair, using a lock to prevent duplicate installation.
 * @example startAutoBootstrap(process.cwd())
 */
function startAutoBootstrap(cwd, options = {}) {
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') return false;
  if (process.env.CODEMAP_BOOST_DISABLE_BOOTSTRAP === '1') return false;
  const root = repoRoot(cwd);
  if (!root) return false;
  const probe = options.canUseCrg || canUseCrg;
  const hasCrg = probe();
  if (hasCrg) {
    enableCodeMap();
    return false;
  }
  const lockFile = path.join(os.tmpdir(), lockName('codemap-bootstrap', root));
  // Whether another process holds the lock or this process just acquired it, report bootstrap in progress instead of silently skipping.
  if (isLockActive(lockFile, BOOTSTRAP_LOCK_STALE_MS)) return true;
  if (!tryWriteLock(lockFile)) {
    if (isLockActive(lockFile, BOOTSTRAP_LOCK_STALE_MS)) return true;
    writeBootstrapDiagnostic('CodeMap Boost could not create the background installation lock. Check plugin-data permissions, run setup, and open a new task.');
    return false;
  }
  const code = `
    const fs = require('fs');
    const { markerPath } = require(${JSON.stringify(path.join(__dirname, 'runtime.js'))});
    const { ensureCrg } = require(${JSON.stringify(path.join(__dirname, 'bootstrap.js'))});
    const codemap = require(${JSON.stringify(__filename)});
    try {
      try { fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid)); } catch (_) {}
      if (ensureCrg()) {
        const migration = codemap.removeLegacyCrgMcp({ cwd: ${JSON.stringify(root)} });
        if (migration.ok) {
          codemap.enableCodeMap();
          try { fs.rmSync(markerPath(${JSON.stringify(BOOTSTRAP_FAILED_MARKER)}), { force: true }); } catch (_) {}
          codemap.cleanLegacyCrgHooks();
          codemap.cleanLegacyCrgGitHook(${JSON.stringify(root)});
          codemap.ensureAgentsBlock();
          codemap.ensureGitInfoExclude(${JSON.stringify(root)});
          codemap.startCrgBuild(${JSON.stringify(root)});
        } else {
          try { fs.writeFileSync(markerPath(${JSON.stringify(BOOTSTRAP_FAILED_MARKER)}), migration.diagnostic || '1'); } catch (_) {}
        }
      } else {
        const diagnostic = codemap.readBootstrapFailure();
        try { fs.writeFileSync(markerPath(${JSON.stringify(BOOTSTRAP_FAILED_MARKER)}), diagnostic || '1'); } catch (_) {}
      }
    } finally {
      try { fs.unlinkSync(${JSON.stringify(lockFile)}); } catch (_) {}
    }
  `;
  const launch = options.spawnDetached || spawnDetached;
  const child = launch(process.execPath, ['-e', code], { cwd: root });
  if (!child) {
    try { fs.unlinkSync(lockFile); } catch (_) {}
    writeBootstrapDiagnostic('CodeMap Boost could not start background isolated-runtime installation. Run setup in the target repository and open a new task.');
    return false;
  }
  return true;
}

function startCrgUpdate(cwd, options = {}) {
  if (process.env.CODEMAP_BOOST_DISABLE_BACKGROUND === '1') return false;
  const root = repoRoot(cwd);
  if (!root) return false;
  const enabled = options.isCodeMapEnabled || (() => isCodeMapEnabled() && canUseCrg());
  if (!enabled()) return false;
  if (!fs.existsSync(path.join(root, '.code-review-graph'))) return false;
  const lockFile = path.join(os.tmpdir(), lockName('codemap-crg-refresh', root));
  const pendingFile = `${lockFile}.pending`;
  if (isLockActive(lockFile)) {
    try { fs.writeFileSync(pendingFile, '1', 'utf8'); } catch (_) {}
    return true;
  }
  if (!tryWriteLock(lockFile)) return false;
  const command = crgCommand(options);
  const code = `
    const fs = require('fs');
    const codemap = require(${JSON.stringify(__filename)});
    try {
      try { fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid)); } catch (_) {}
      do {
        try { fs.rmSync(${JSON.stringify(pendingFile)}, { force: true }); } catch (_) {}
        codemap.refreshCrgUnlocked(${JSON.stringify(root)}, { crgCommand: ${JSON.stringify(command)} });
      } while (fs.existsSync(${JSON.stringify(pendingFile)}));
    } finally {
      try { fs.unlinkSync(${JSON.stringify(lockFile)}); } catch (_) {}
      try { fs.rmSync(${JSON.stringify(pendingFile)}, { force: true }); } catch (_) {}
    }
  `;
  const launch = options.spawnDetached || spawnDetached;
  const child = launch(process.execPath, ['-e', code], { cwd: root });
  if (!child) {
    try { fs.unlinkSync(lockFile); } catch (_) {}
    try { fs.rmSync(pendingFile, { force: true }); } catch (_) {}
    return false;
  }
  return true;
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/[\u001b\u005d].*?(?:\u0007|\u001b\\)/g, '');
}

function parseMcpJson(value) {
  if (value && typeof value === 'object') return value;
  const text = stripAnsi(value);
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    let depth = 0;
    let quote = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quote = false;
        continue;
      }
      if (char === '"') {
        quote = true;
        continue;
      }
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') depth -= 1;
      if (depth !== 0) continue;
      try { return JSON.parse(text.slice(start, index + 1)); } catch (_) { break; }
    }
  }
  return null;
}

function mcpTransport(config) {
  if (!config || typeof config !== 'object') return {};
  const transport = config.transport;
  if (transport && typeof transport === 'object') return transport;
  return config;
}

/**
 * Check whether a same-name global MCP uses an old uvx launcher with ambiguous ownership.
 * @example isLegacyUvxCrgMcpConfig({ command: 'uvx', args: ['code-review-graph', 'serve'] })
 */
function isLegacyUvxCrgMcpConfig(config) {
  if (!config || typeof config !== 'object') return false;
  const transport = mcpTransport(config);
  const type = typeof config.transport === 'string'
    ? config.transport
    : (transport.type || config.type || config.transport_type || 'stdio');
  if (String(type).toLowerCase() !== 'stdio') return false;
  const command = String(transport.command || config.command || '');
  const args = transport.args || config.args;
  if (!Array.isArray(args)) return false;
  const normalizedArgs = JSON.stringify(args);
  return path.basename(command).toLowerCase() === 'uvx'
    && normalizedArgs === JSON.stringify(['code-review-graph', 'serve']);
}

/**
 * Check whether a path proves that a same-name global MCP belongs to the old plugin-private runtime.
 * @example isPluginManagedLegacyCrgMcpConfig({ command: '/home/me/.codex/plugins/data/codemap-boost-codex-shop/crg-runtime/bin/code-review-graph', args: ['serve'] })
 */
function isPluginManagedLegacyCrgMcpConfig(config) {
  if (!config || typeof config !== 'object') return false;
  const transport = mcpTransport(config);
  const type = typeof config.transport === 'string'
    ? config.transport
    : (transport.type || config.type || config.transport_type || 'stdio');
  if (String(type).toLowerCase() !== 'stdio') return false;
  const command = String(transport.command || config.command || '').replace(/\\/g, '/');
  const args = transport.args || config.args;
  if (!Array.isArray(args)) return false;
  return /\/plugins\/data\/codemap-boost-codex(?:-[^/]+)?\/crg-runtime\/(?:Scripts|bin)\/code-review-graph(?:\.exe)?$/i.test(command)
    && JSON.stringify(args) === JSON.stringify(['serve']);
}

/**
 * Check whether the current MCP configuration uses the plugin’s bundled cross-platform launcher.
 * @example isNativeCrgMcpConfig({ command: 'node', args: ['scripts/mcp-server.cjs'], cwd: '.', startup_timeout_sec: 600 }, { allowRelativeCwd: true })
 */
function isNativeCrgMcpConfig(config, options = {}) {
  if (!config || typeof config !== 'object') return false;
  if (config.enabled === false && !options.allowDisabled) return false;
  const transport = mcpTransport(config);
  const type = typeof config.transport === 'string'
    ? config.transport
    : (transport.type || config.type || config.transport_type || 'stdio');
  const command = String(transport.command || config.command || '');
  const args = transport.args || config.args;
  const cwd = String(transport.cwd ?? config.cwd ?? '');
  const timeout = Number(config.startup_timeout_sec ?? config.startupTimeoutSec);
  let cwdOk = false;
  if (options.allowRelativeCwd) cwdOk = cwd === '.';
  else if (options.expectedCwd && cwd) {
    const actual = path.resolve(cwd);
    const expected = path.resolve(options.expectedCwd);
    cwdOk = process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  }
  return String(type).toLowerCase() === 'stdio'
    && ['node', 'node.exe'].includes(path.basename(command).toLowerCase())
    && Array.isArray(args)
    && JSON.stringify(args) === JSON.stringify(['scripts/mcp-server.cjs'])
    && cwdOk
    && Number.isFinite(timeout)
    && timeout === MCP_STARTUP_TIMEOUT_SEC;
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

/**
 * Run a resolved Codex CLI; Windows batch entry points must launch through cmd.exe.
 * @example runCodexCommand('codex', ['--version'])
 */
function runCodexCommand(command, args, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const env = options.env || process.env;
  const useCmdShim = process.platform === 'win32'
    && !options.spawnSync
    && /\.(?:cmd|bat)$/i.test(command);
  const executable = useCmdShim ? (env.ComSpec || process.env.ComSpec || 'cmd.exe') : command;
  const commandEnv = useCmdShim ? { ...env, CODEMAP_BOOST_CODEX_COMMAND: command } : env;
  if (useCmdShim) {
    args.forEach((arg, index) => {
      commandEnv[`CODEMAP_BOOST_CODEX_ARG_${index}`] = String(arg);
    });
  }
  const commandArgRefs = args.map((arg, index) => {
    const ref = `%CODEMAP_BOOST_CODEX_ARG_${index}%`;
    return /^[A-Za-z0-9_./:\\-]+$/.test(String(arg)) ? ref : `"${ref}"`;
  });
  const commandArgs = useCmdShim
    ? [
        '/d',
        '/v:off',
        '/s',
        '/c',
        `""%CODEMAP_BOOST_CODEX_COMMAND%" ${commandArgRefs.join(' ')}"`,
      ]
    : args;
  try {
    return spawn(executable, commandArgs, {
      cwd: options.cwd || process.cwd(),
      env: commandEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout || 30000,
      windowsHide: process.platform === 'win32',
      windowsVerbatimArguments: useCmdShim,
    });
  } catch (error) {
    return { status: null, error, stdout: '', stderr: '' };
  }
}

/**
 * Probe Codex CLI candidates from PATH one by one, skipping desktop-app entries that exist but cannot execute.
 * @example resolveCodexCommand({ cwd: process.cwd() })
 */
function resolveCodexCommand(options = {}) {
  const env = options.env || process.env;
  const explicit = String(env.CODEMAP_BOOST_CODEX_CLI || '').trim();
  const candidates = [];
  if (explicit) {
    candidates.push(explicit);
  } else {
    const suffixes = process.platform === 'win32'
      ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
    const names = process.platform === 'win32'
      ? [...suffixes.map((suffix) => `codex${suffix.toLowerCase()}`), 'codex']
      : ['codex'];
    for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const name of names) {
        const candidate = path.resolve(directory.replace(/^"|"$/g, ''), name);
        try {
          if (fs.statSync(candidate).isFile()) candidates.push(candidate);
        } catch (_) {}
      }
    }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    const probe = runCodexCommand(candidate, ['--version'], { ...options, env, timeout: 10000 });
    if (probe && !probe.error && probe.status === 0) return candidate;
  }
  return null;
}

/**
 * Run Codex MCP subcommands through a verified CLI; tests may inject spawnSync.
 * @example runCodexMcp(['mcp', 'get', 'code-review-graph', '--json'])
 */
function runCodexMcp(args, options = {}) {
  const command = options.codexCommand
    || (options.spawnSync ? 'codex' : resolveCodexCommand(options));
  if (!command) {
    const error = new Error('Codex CLI is unavailable');
    error.code = 'ENOENT';
    return { status: null, error, stdout: '', stderr: '', available: false };
  }
  return runCodexCommand(command, args, options);
}

/**
 * Remove an old global registration only when its private-runtime path proves plugin ownership.
 * @example removeLegacyCrgMcp({ cwd: process.cwd() })
 */
function removeLegacyCrgMcp(options = {}) {
  const codexCommand = options.codexCommand
    || (options.spawnSync ? 'codex' : resolveCodexCommand(options));
  if (!codexCommand) {
    return {
      ok: true,
      changed: false,
      skipped: true,
      diagnostic: 'No executable standalone Codex CLI was found, so old global MCP overrides cannot be checked; the native plugin MCP launcher itself does not depend on the CLI.',
    };
  }
  const commandOptions = { ...options, codexCommand };
  const getResult = runCodexMcp(['mcp', 'get', 'code-review-graph', '--json'], commandOptions);
  const output = `${getResult && getResult.stdout ? getResult.stdout : ''}\n${getResult && getResult.stderr ? getResult.stderr : ''}`;
  const config = parseMcpJson(output);
  if (!isPluginManagedLegacyCrgMcpConfig(config)) return { ok: true, changed: false };
  const removeResult = runCodexMcp(['mcp', 'remove', 'code-review-graph'], commandOptions);
  if (removeResult && !removeResult.error && removeResult.status === 0) {
    return { ok: true, changed: true };
  }
  return {
    ok: false,
    changed: false,
    diagnostic: 'Could not remove the old global code-review-graph registration. It shadows the native plugin MCP; run setup to repair it automatically.',
  };
}

/**
 * Run the legacy MCP migration until it has checked a real Codex CLI once, then never again.
 * SessionStart fires on startup, resume, clear and compact; repeating CLI probes there only adds latency.
 * When no usable CLI exists the check is skipped and retried at most once a day, so an unrunnable desktop-app
 * entry on PATH does not cost a failed `codex --version` probe at every session start.
 * @example removeLegacyCrgMcpOnce({ cwd: process.cwd() })
 */
function removeLegacyCrgMcpOnce(options = {}) {
  const marker = markerPath(LEGACY_MCP_CHECKED_MARKER);
  const now = (options.now || Date.now)();
  try {
    const recorded = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (recorded && (recorded.status === 'checked'
        || (recorded.status === 'skipped' && now - recorded.at < LEGACY_MCP_RETRY_MS))) {
      return { ok: true, changed: false, cached: true };
    }
  } catch (_) {} // missing or unreadable marker: run the check
  const result = (options.removeLegacyCrgMcp || removeLegacyCrgMcp)(options);
  if (result.ok) {
    // A failed removal (ok: false) is never recorded, so it is retried at the next session start.
    try {
      ensureDir(path.dirname(marker));
      fs.writeFileSync(marker, JSON.stringify({ status: result.skipped ? 'skipped' : 'checked', at: now }));
    } catch (_) {}
  }
  return result;
}

const CONTEXT = GUIDANCE;

function promptLooksStructural(text) {
  const value = String(text || '').toLowerCase();
  return /\b(?:callers?|callees?|dependencies|depends? on|references?|call (?:graph|chain)|impact (?:radius|analysis)|review context|codemap|code map)\b|\u4ee3\u7801\u7ed3\u6784|\u7b26\u53f7\u5173\u7cfb|\u8c03\u7528|\u5f15\u7528\u5173\u7cfb|\u5f71\u54cd\u9762|\u4ee3\u7801\u5ba1\u67e5|\u6a21\u5757\u4f9d\u8d56|\u4f9d\u8d56\u5173\u7cfb|\u4f9d\u8d56\u94fe/.test(value)
    || /\b(?:review|inspect|check)\b.{0,50}\b(?:code|patch|changes?|diff|regressions?)\b/.test(value)
    || /(?:\u5206\u6790|\u68b3\u7406|\u67e5\u627e|\u5b9a\u4f4d|\u4e86\u89e3).{0,30}(?:\u67b6\u6784|\u6a21\u5757|\u7b26\u53f7|\u51fd\u6570|\u7c7b)|(?:find|locate|trace|inspect|explain)\b.{0,40}\b(?:symbols?|functions?|classes|architecture|modules?)\b/.test(value);
}

function normalizeLegacyCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

function isLegacyCrgCommand(command) {
  const normalized = normalizeLegacyCommand(command);
  return normalized === 'code-review-graph status || true'
    || normalized === 'code-review-graph update --skip-flows || true'
    || normalized === 'cat >/dev/null || true; code-review-graph status || true'
    || normalized === 'cat >/dev/null || true; code-review-graph update --skip-flows || true';
}

function cleanLegacyCrgHooks(home = codexHome()) {
  const target = path.join(home, 'hooks.json');
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.hooks) return false;
  let changed = false;
  for (const eventName of Object.keys(parsed.hooks)) {
    if (!Array.isArray(parsed.hooks[eventName])) continue;
    const next = [];
    for (const group of parsed.hooks[eventName]) {
      if (!group || !Array.isArray(group.hooks)) {
        next.push(group);
        continue;
      }
      const hooks = group.hooks.filter((hook) => !isLegacyCrgCommand(hook && hook.command));
      if (hooks.length !== group.hooks.length) changed = true;
      if (hooks.length > 0) next.push({ ...group, hooks });
    }
    if (next.length !== parsed.hooks[eventName].length) {
      changed = true;
      if (next.length === 0) delete parsed.hooks[eventName];
      else parsed.hooks[eventName] = next;
    }
  }
  if (!changed) return false;
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return true;
}

/**
 * Remove legacy CRG lines only from the Git hook path effective for the current repository.
 * @example cleanLegacyCrgGitHook(process.cwd())
 */
function cleanLegacyCrgGitHook(cwd) {
  const root = repoRoot(cwd);
  if (!root) return false;
  let target = '';
  try {
    const result = spawnSync('git', ['rev-parse', '--git-path', 'hooks/pre-commit'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: process.platform === 'win32',
      timeout: 5000,
    });
    if (!result.error && result.status === 0) target = result.stdout.trim();
  } catch (_) {}
  if (!target) return false;
  if (!path.isAbsolute(target)) target = path.resolve(root, target);
  let content = '';
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return false;
  }
  if (!content.includes('Installed by code-review-graph')) return false;
  if (!content.includes('code-review-graph update')) return false;
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) =>
    !line.includes('Installed by code-review-graph')
    && normalizeLegacyCommand(line) !== 'code-review-graph update || true'
  );
  const meaningful = kept.filter((line) => {
    const trimmed = line.trim();
    return trimmed && trimmed !== '#!/bin/sh' && trimmed !== '#!/usr/bin/env sh';
  });
  try {
    if (meaningful.length === 0) {
      fs.unlinkSync(target);
    } else {
      fs.writeFileSync(target, `${kept.join('\n').replace(/\s+$/, '')}\n`, 'utf8');
    }
    return true;
  } catch (_) {
    return false;
  }
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
  startAutoBootstrap,
  startCrgBuild,
  startCrgUpdate,
  refreshCrgUnlocked,
  refreshCrgSync,
  prepareCrgForRead,
  listLinkedWorktrees,
  refreshLinkedWorktreesSync,
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
