'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const { readStdinJson } = require('./lib/stdin');
const { passSilent, denyTool, diag } = require('./lib/protocol');
const { loadConfig } = require('./lib/config');
const { repoRoot, isNew } = require('./lib/git');
const { createStagedSnapshot } = require('./lib/staged_snapshot');
const { shouldHandle } = require('./lib/target');
const { isVisualStudioSource } = require('./lib/line_endings');
const { runCpplint, formatViolations } = require('./steps/cpplint');

const isWindows = process.platform === 'win32';
const PRE_COMMIT_DEADLINE_MS = 25000;

/**
 * Tokenize a shell command to identify a real `git commit`:
 * - Accept case variants, git.exe, absolute paths, and common wrappers for the Git executable.
 * - commit must be its own subcommand; exclude commit-graph, commit-tree, and strings in echo.
 * - Return false on uncertainty (allow rather than block).
 * @param {string} command
 * @returns {boolean}
 */
function tokenizeCommand(command) {
  return String(command).trim().match(/(?:"[^"]*"|'[^']*'|\S+)/g) || [];
}

function unquote(token) {
  return String(token).replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * Split at unquoted shell connectors while preserving the inner structure of `cmd /c "... && ..."`.
 *
 * @param {string} command Original command
 * @returns {string[]} Command segments in order
 * @example
 * splitCommandSegments('cd repo && git commit') // ['cd repo', 'git commit']
 * splitCommandSegments('true & (git commit)') // ['true', 'git commit']
 */
function splitCommandSegments(command) {
  const text = String(command);
  const segments = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const pair = text.slice(index, index + 2);
    // A single & backgrounds the left side (but `>&` and `<&` are redirections); a newline ends a command like ;
    // and an unquoted parenthesis opens or closes a subshell, so the command inside it is its own segment.
    const separatorLength = pair === '&&' || pair === '||' ? 2
      : (char === ';' || char === '|' || char === '\n' || char === '\r' || char === '(' || char === ')'
        || (char === '&' && text[index - 1] !== '>' && text[index - 1] !== '<') ? 1 : 0);
    if (!separatorLength) continue;
    const segment = text.slice(start, index).trim();
    if (segment) segments.push(segment);
    index += separatorLength - 1;
    start = index + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

/**
 * Extract and lowercase the executable basename, supporting POSIX and Windows separators.
 *
 * @param {string} token Command token
 * @returns {string} Normalized command name
 * @example
 * commandName('C:\\Program Files\\Git\\cmd\\git.exe') // 'git.exe'
 */
function commandName(token) {
  const parts = unquote(token).split(/[\\/]/);
  return String(parts[parts.length - 1] || '').toLowerCase();
}

/**
 * Check whether a token names Git, accepting git, git.exe, and absolute paths.
 *
 * @param {string} token Command token
 * @returns {boolean} Whether this is a Git executable
 * @example
 * isGitExecutable('/usr/bin/git') // true
 */
function isGitExecutable(token) {
  const name = commandName(token);
  return name === 'git' || name === 'git.exe';
}

function normalizedCommandTokens(segment) {
  let tokens = tokenizeCommand(segment);
  while (tokens.length > 0) {
    const head = commandName(tokens[0]);
    if (head === 'command' || head === '&') {
      tokens = tokens.slice(1);
      continue;
    }
    return tokens;
  }
  return tokens;
}

/**
 * Extract the wrapped command from Windows `cmd[.exe] ... /c <command>`; return null for other segments.
 *
 * @param {string} segment One outer command segment
 * @returns {string|null} Wrapped command
 * @example
 * cmdWrappedCommand('cmd.exe /d /s /c git commit') // 'git commit'
 */
function cmdWrappedCommand(segment) {
  const tokens = tokenizeCommand(segment);
  if (tokens.length === 0 || !['cmd', 'cmd.exe'].includes(commandName(tokens[0]))) return null;
  const commandIndex = tokens.findIndex((token, index) => (
    index > 0 && unquote(token).toLowerCase() === '/c'
  ));
  if (commandIndex < 0 || commandIndex + 1 >= tokens.length) return '';
  const wrapped = tokens.slice(commandIndex + 1);
  return wrapped.length === 1 ? unquote(wrapped[0]) : wrapped.join(' ');
}

function gitSubcommand(tokens) {
  if (tokens.length === 0 || !isGitExecutable(tokens[0])) return null;
  let i = 1;
  while (i < tokens.length) {
    const tok = unquote(tokens[i]);
    if (tok === '-C' || tok === '-c' || tok === '--git-dir' || tok === '--work-tree') {
      i += 2;
      continue;
    }
    if (tok.startsWith('--git-dir=') || tok.startsWith('--work-tree=')) {
      i += 1;
      continue;
    }
    if (tok.startsWith('-')) {
      i += 1;
      continue;
    }
    return tok.toLowerCase();
  }
  return null;
}

function segmentIsGitCommit(segment) {
  const tokens = normalizedCommandTokens(segment);
  if (tokens.length === 0) return false;
  return gitSubcommand(tokens) === 'commit';
}

function gitCommitCwdFromTokens(tokens, cwd) {
  if (tokens.length === 0 || !isGitExecutable(tokens[0])) return null;
  let current = path.resolve(cwd);
  let i = 1;
  while (i < tokens.length) {
    const tok = unquote(tokens[i]);
    if (tok === '-C') {
      if (i + 1 >= tokens.length) return null;
      current = path.resolve(current, unquote(tokens[i + 1]));
      i += 2;
      continue;
    }
    if (tok === '-c' || tok === '--git-dir' || tok === '--work-tree') {
      i += 2;
      continue;
    }
    if (tok.startsWith('--git-dir=') || tok.startsWith('--work-tree=')) {
      i += 1;
      continue;
    }
    if (tok.startsWith('-')) {
      i += 1;
      continue;
    }
    return tok.toLowerCase() === 'commit' ? current : null;
  }
  return null;
}

function commitCwd(command, baseCwd = process.cwd()) {
  if (typeof command !== 'string') return null;
  let current = path.resolve(baseCwd);
  for (const segment of splitCommandSegments(command)) {
    const wrapped = cmdWrappedCommand(segment);
    if (wrapped !== null) {
      if (!wrapped) continue;
      const nestedTarget = commitCwd(wrapped, current);
      if (nestedTarget) return nestedTarget;
      continue;
    }
    const tokens = normalizedCommandTokens(segment);
    if (tokens.length === 0) continue;
    const head = commandName(tokens[0]);
    if (head === 'cd' && tokens.length >= 2) {
      const targetIndex = unquote(tokens[1]).toLowerCase() === '/d' ? 2 : 1;
      if (targetIndex >= tokens.length) return null;
      current = path.resolve(current, unquote(tokens[targetIndex]));
      continue;
    }
    const target = gitCommitCwdFromTokens(tokens, current);
    if (target) return target;
  }
  return null;
}

function isGitCommit(command) {
  return commitCwd(command) !== null;
}

/**
 * List staged C++ files via Git `-z` (--diff-filter=ACM), preserving filenames at NUL boundaries.
 * @param {string} root
 * @returns {string[]} Array of absolute paths
 */
function stagedCppFiles(root, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  let r;
  try {
    r = spawn('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACM'], {
      cwd: root,
      encoding: null,
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: isWindows,
    });
  } catch (error) {
    throw new Error(`Failed to start git diff --cached:${error && error.message ? error.message : error}`);
  }
  if (!r || r.error || r.status !== 0) {
    const reason = r && r.error
      ? (r.error.code || r.error.message)
      : `exit code ${r && r.status !== undefined ? r.status : 'unknown'}`;
    throw new Error(`git diff --cached could not enumerate staged files: ${reason}`);
  }
  if (!r.stdout) return [];
  return Buffer.from(r.stdout)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((rel) => path.resolve(root, ...rel.split('/')))
    .filter((abs) => shouldHandle(abs));
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 5000 });
  if (!input) return passSilent();

  const command = input.tool_input && input.tool_input.command;
  const baseCwd = input.cwd ? path.resolve(input.cwd) : process.cwd();
  const cwd = commitCwd(command, baseCwd);
  if (!cwd) return passSilent();

  // loadConfig/findProjectConfig search upward from path.dirname(filePath); pass a probe file under cwd
  // so its dirname is cwd and includes cwd/.codex-cpp-style/cpp-style.json.
  const config = loadConfig(path.join(cwd, '.cpp-style-probe'));
  if (config.enabled === false || (!config.checks.cpplint
      && (config.mode === 'full' || !config.legacyChecks.cpplint))) return passSilent();

  const root = repoRoot(cwd);
  if (!root) return passSilent();

  let files;
  try {
    files = stagedCppFiles(root);
  } catch (error) {
    return denyTool(`Commit blocked: could not enumerate the Git staging area, so cpplint was incomplete.${error && error.message ? ` ${error.message}` : ''}`);
  }
  const fileChecks = new Map(files.map((file) => [file,
    config.mode === 'full' || isNew(file, root) !== false ? config.checks : config.legacyChecks]));
  files = files.filter((file) => fileChecks.get(file).cpplint);
  if (files.length === 0) return passSilent();

  const allViolations = [];
  const deadline = Date.now() + PRE_COMMIT_DEADLINE_MS;
  let snapshot;
  let cleanupError = null;
  try {
    snapshot = createStagedSnapshot(root, files);
    for (const stagedFile of snapshot.files) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 1000) {
        allViolations.push({
          file: stagedFile.relativePath,
          line: 0,
          category: 'runtime/timeout',
          message: 'Pre-commit cpplint exceeded its total time budget; remaining files were not checked',
        });
        break;
      }
      try {
        const effectiveChecks = fileChecks.get(path.resolve(root, stagedFile.relativePath));
        const suppressCopyright = !(config.copyrightInfo && config.copyrightInfo.company)
          || !effectiveChecks.copyright;
        const v = runCpplint(stagedFile.filePath, {
          root: snapshot.root,
          suppressCopyright,
          // The snapshot may omit project files; classify from original paths while reading source only from the index.
          preserveIncludeOrder: isVisualStudioSource(path.resolve(root, stagedFile.relativePath), root),
          timeoutMs: Math.min(15000, remainingMs),
        });
        for (const item of v) allViolations.push({ ...item, file: stagedFile.relativePath });
        if (v.some((item) => item.category === 'runtime/timeout')) break;
      } catch (e) {
        allViolations.push({ file: stagedFile.relativePath, line: 0,
          category: 'runtime/cpplint',
          message: `Check error; verification incomplete: ${e && e.message ? e.message : e}` });
      }
    }
  } catch (e) {
    return denyTool(`Commit blocked: could not create a Git index snapshot; cpplint was not run.${e && e.message ? ` ${e.message}` : ''}`);
  } finally {
    if (snapshot) {
      try { snapshot.cleanup(); } catch (error) { cleanupError = error; }
    }
  }

  if (cleanupError) {
    return denyTool(`Commit blocked: could not clean up the temporary Git index snapshot.${cleanupError.message ? ` ${cleanupError.message}` : ''}`);
  }

  // All staged cpplint violations are hard failures that block commit.
  if (allViolations.length > 0) {
    return denyTool('Commit blocked: staged C++ files have cpplint violations.\n' + formatViolations(allViolations));
  }
  return passSilent();
}

// Run the pipeline only when invoked directly as a hook; when required by tests, export functions without blocking on stdin.
if (require.main === module) {
  main().catch((e) => {
    try { diag(`pre_commit check error: ${e && e.message ? e.message : e}`); } catch (_) {}
    denyTool('Pre-commit C++ check failed; verification is incomplete. Fix the check environment and retry.');
  });
}

module.exports = {
  commitCwd,
  gitSubcommand,
  isGitCommit,
  splitCommandSegments,
  stagedCppFiles,
  tokenizeCommand,
};
