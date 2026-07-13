'use strict';

const path = require('path');

const CONTROL_OPERATORS = new Set(['&&', '||', ';', '|', '&']);
const TWO_CHAR_OPERATORS = new Set([
  '&&', '||', '>>', '<<', '&>', '>|', '<>', '>&', '<&',
]);
const ONE_CHAR_OPERATORS = new Set([';', '|', '&', '>', '<']);
const OUTPUT_REDIRECTS = new Set(['>', '>>', '<<', '&>', '>|', '<>', '>&']);

const DANGEROUS_PATTERNS = [
  /(?:^|[;&|]\s*)rm\s+[^\r\n]*(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)/i,
  /(?:^|[;&|]\s*)remove-item\b[^\r\n]*-(?:recurse|force)\b/i,
  /\bgit\b[^\r\n;&|]*\bpush\b[^\r\n;&|]*(?:--force(?:-with-lease)?|-f\b)/i,
  /\bgit\b[^\r\n;&|]*\breset\b[^\r\n;&|]*--hard\b/i,
  /\bgit\b[^\r\n;&|]*\bclean\b[^\r\n;&|]*(?:\s-f\b|\s-[a-z]*f[a-z]*\b)/i,
  /\bgit\b[^\r\n;&|]*\bbranch\b[^\r\n;&|]*\s-D\b/i,
  /\bgit\b[^\r\n;&|]*\b(?:checkout|restore)\b[^\r\n;&|]*--\s+\.\b/i,
];

function hasOutputRedirect(command) {
  return lexCommand(command).some((token) => OUTPUT_REDIRECTS.has(token));
}

function hasAmbiguousCrossShellEscape(command) {
  return /\\(?=["'$`;&|><()])|\\\r?\n/.test(String(command || ''));
}

function lexCommand(command) {
  if (typeof command !== 'string') return [];
  const tokens = [];
  let current = '';
  let quote = null;

  function flush() {
    if (current) tokens.push(current);
    current = '';
  }

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      flush();
      if (ch === '\r' && command[i + 1] === '\n') i += 1;
      tokens.push(';');
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (TWO_CHAR_OPERATORS.has(pair)) {
      flush();
      tokens.push(pair);
      i += 1;
      continue;
    }
    if (ONE_CHAR_OPERATORS.has(ch)) {
      flush();
      tokens.push(ch);
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

function tokenSegments(command) {
  const segments = [[]];
  for (const token of lexCommand(command)) {
    if (CONTROL_OPERATORS.has(token)) segments.push([]);
    else segments[segments.length - 1].push(token);
  }
  return segments.filter((segment) => segment.length > 0);
}

function splitCommandSegments(command) {
  const segments = tokenSegments(command).map((segment) => segment.join(' '));
  return segments;
}

function tokenizeSegment(segment) {
  return lexCommand(segment).filter((token) => !CONTROL_OPERATORS.has(token));
}

function normalizeHead(raw) {
  let value = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  value = value.replace(/^&$/, '');
  if (!value) return '';
  value = path.win32.basename(value.replace(/\//g, '\\')).toLowerCase();
  return value.replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
}

function segmentHead(segment) {
  const tokens = Array.isArray(segment) ? [...segment] : tokenizeSegment(segment);
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || /^\$env:[^=]+=/i.test(tokens[0]))) {
    tokens.shift();
  }
  if (tokens[0] === '&' || tokens[0] === 'command' || tokens[0] === 'sudo') tokens.shift();
  return { head: normalizeHead(tokens[0]), tokens };
}

function stripQuotes(value) {
  return String(value || '').replace(/^['"]|['"]$/g, '');
}

function stripGitGlobalOptions(args) {
  const out = [...args];
  const withValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);
  const flags = new Set(['--no-pager', '--paginate', '--literal-pathspecs', '--no-literal-pathspecs']);
  while (out.length) {
    const head = stripQuotes(out[0]);
    if (withValue.has(head)) {
      if (out.length < 2) return [];
      out.splice(0, 2);
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace|super-prefix)=/.test(head) || flags.has(head)) {
      out.shift();
      continue;
    }
    break;
  }
  return out;
}

function isDangerousPush(args) {
  const values = args.map(stripQuotes);
  return values.some((arg) =>
    arg === '--force'
    || arg.startsWith('--force=')
    || arg.startsWith('--force-with-lease')
    || arg === '--force-if-includes'
    || arg === '-f'
    || arg === '--mirror'
    || arg === '--prune'
    || arg === '--delete'
    || arg === '-d'
    || arg.startsWith('+')
    || /^:[^/]/.test(arg)
  );
}

function isReadonlyGitCompound(subcommand, args) {
  const values = args.map(stripQuotes);
  if (subcommand === 'remote') {
    return values[0] === '-v'
      || values[0] === '--verbose'
      || values[0] === 'show'
      || values[0] === 'get-url';
  }
  if (subcommand === 'config') {
    const mutating = new Set([
      '--add', '--replace-all', '--unset', '--unset-all', '--rename-section',
      '--remove-section', '--edit', '-e',
    ]);
    if (values.some((arg) => mutating.has(arg))) return false;
    return values.some((arg) =>
      arg === '--get'
      || arg === '--get-all'
      || arg === '--get-regexp'
      || arg === '--get-urlmatch'
      || arg === '--list'
      || arg === '-l'
    );
  }
  if (subcommand === 'stash') return values[0] === 'list' || values[0] === 'show';
  if (subcommand === 'tag') return values.length === 0 || values[0] === '-l' || values[0] === '--list';
  if (subcommand === 'branch') {
    const safeFlags = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current']);
    return values.length === 0 || values.every((arg) => safeFlags.has(arg));
  }
  return null;
}

function analyzeGit(tokens, config) {
  const args = stripGitGlobalOptions(tokens.slice(1));
  const subcommand = stripQuotes(args[0]).toLowerCase();
  if (!subcommand) return { safe: false, reason: 'git command has no subcommand' };
  const subArgs = args.slice(1);
  if (subcommand === 'push' && isDangerousPush(subArgs)) {
    return { safe: false, reason: 'git push option can rewrite or delete remote refs' };
  }
  const compound = isReadonlyGitCompound(subcommand, subArgs);
  if (compound !== null) {
    return compound
      ? { safe: true }
      : { safe: false, reason: `git ${subcommand} form is not read-only` };
  }
  const readonly = new Set(config.whitelist.git_readonly || []);
  const safeWrite = new Set(config.whitelist.git_safe_write || []);
  if (readonly.has(subcommand) || safeWrite.has(subcommand)) return { safe: true };
  return { safe: false, reason: `git subcommand is not lightweight: ${subcommand}` };
}

function analyzeShellCommand(command, config) {
  if (typeof command !== 'string' || !command.trim()) {
    return { safe: false, reason: 'empty shell command', heads: [] };
  }
  if (/\$\(|`|<\(|>\(/.test(command)) {
    return { safe: false, reason: 'command substitution requires delegated review', heads: [] };
  }
  if (hasAmbiguousCrossShellEscape(command)) {
    return { safe: false, reason: 'cross-shell escape is ambiguous', heads: [] };
  }
  if (hasOutputRedirect(command)) {
    return { safe: false, reason: 'shell redirection can write files', heads: [] };
  }
  if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))) {
    return { safe: false, reason: 'destructive shell pattern', heads: [] };
  }

  const segments = tokenSegments(command);
  if (!segments.length) return { safe: false, reason: 'no command segments', heads: [] };
  const allowedHeads = new Set((config.whitelist.shell_heads || []).map((item) => String(item).toLowerCase()));
  const heads = [];

  for (const segment of segments) {
    const parsed = segmentHead(segment);
    heads.push(parsed.head);
    if (!parsed.head) return { safe: false, reason: 'unknown command head', heads };
    if (parsed.head === 'git') {
      const git = analyzeGit(parsed.tokens, config);
      if (!git.safe) return { ...git, heads };
      continue;
    }
    if (!allowedHeads.has(parsed.head)) {
      return { safe: false, reason: `command is not lightweight: ${parsed.head}`, heads };
    }
  }
  return { safe: true, heads };
}

module.exports = {
  analyzeShellCommand,
  hasAmbiguousCrossShellEscape,
  hasOutputRedirect,
  lexCommand,
  normalizeHead,
  splitCommandSegments,
  tokenizeSegment,
};
