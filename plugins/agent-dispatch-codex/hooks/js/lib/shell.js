'use strict';

const path = require('path');

const CONTROL_OPERATORS = new Set(['&&', '||', ';', '|', '&']);
const TWO_CHAR_OPERATORS = new Set([
  '&&', '||', '>>', '<<', '&>', '>|', '<>', '>&', '<&',
]);
const ONE_CHAR_OPERATORS = new Set([';', '|', '&', '>', '<']);
const OUTPUT_REDIRECTS = new Set(['>', '>>', '<<', '&>', '>|', '<>', '>&']);

const ENV_OPTIONS_WITH_VALUE = new Set([
  '-a', '--argv0', '-u', '--unset', '-C', '--chdir',
]);
const ENV_SPLIT_OPTIONS = new Set(['-S', '--split-string']);
const SUDO_OPTIONS_WITH_VALUE = new Set([
  '-C', '--close-from', '-D', '--chdir', '-g', '--group', '-h', '--host',
  '-p', '--prompt', '-R', '--chroot', '-r', '--role', '-T',
  '--command-timeout', '-t', '--type', '-u', '--user',
]);

const DANGEROUS_PATTERNS = [
  /(?:^|[;&|]\s*)rm\s+[^\r\n]*(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)/i,
  /(?:^|[;&|]\s*)remove-item\b[^\r\n]*-(?:recurse|force)\b/i,
];

function hasOutputRedirect(command) {
  return lexCommand(command).some((token) => OUTPUT_REDIRECTS.has(token));
}

function hasAmbiguousCrossShellEscape(command) {
  return /\\(?=["'$`;&|><()])|\\\r?\n/.test(String(command || ''));
}

function hasNestedShellEvaluation(command) {
  const value = String(command || '');
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === quote && !isQuoteEscaped(value, i, quote)) {
        quote = null;
        continue;
      }
      if (quote === '"'
          && (ch === '`'
            || (ch === '$' && ['(', '{', '['].includes(value[i + 1])))) {
        return true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '`' || ch === '(' || ch === '{' || ch === '}') return true;
    if (ch === '$' && ['(', '{', '['].includes(value[i + 1])) return true;
    if ((ch === '<' || ch === '>') && /^\s*\(/.test(value.slice(i + 1))) return true;
    if (ch === '<' && value[i + 1] === '#') return true;
    if (ch === '#' && value[i + 1] === '>') return true;
    if (ch === '@' && ['(', '"', "'"].includes(value[i + 1])) return true;
  }
  return false;
}

function isQuoteEscaped(text, index, quote) {
  if (quote !== '"' || index < 1) return false;
  const escape = text[index - 1];
  if (escape !== '\\' && escape !== '`') return false;
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === escape; i -= 1) count += 1;
  return count % 2 === 1;
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
      if (ch === quote && !isQuoteEscaped(command, i, quote)) quote = null;
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

function boundaryIsEscaped(text, boundaryIndex) {
  if (boundaryIndex < 1) return false;
  const escape = text[boundaryIndex - 1];
  if (escape !== '\\' && escape !== '`') return false;
  let count = 0;
  for (let i = boundaryIndex - 1; i >= 0 && text[i] === escape; i -= 1) count += 1;
  return count % 2 === 1;
}

function isCommentStart(text, index) {
  if (text[index] !== '#') return false;
  if (index === 0) return true;
  const boundaryIndex = index - 1;
  return /\s|[;&|]/.test(text[boundaryIndex])
    && !boundaryIsEscaped(text, boundaryIndex);
}

function maskBalancedRegion(source, chars, start, cursor, open, close, depth) {
  for (let i = start; i < cursor; i += 1) chars[i] = ' ';
  let index = cursor - 1;
  while (index + 1 < source.length && depth > 0) {
    index += 1;
    if (source[index] === open) depth += 1;
    else if (source[index] === close) depth -= 1;
    chars[index] = ' ';
  }
  return index;
}

function operatorIsEscaped(source, index) {
  if (index < 1) return false;
  const escape = source[index - 1];
  if (escape !== '\\' && escape !== '`') return false;
  let count = 0;
  for (let i = index - 1; i >= 0 && source[i] === escape; i -= 1) count += 1;
  return count % 2 === 1;
}

function maskNonHeredocContexts(line) {
  const source = String(line || '');
  const chars = [...source];
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote && !isQuoteEscaped(source, i, quote)) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '$' && source[i + 1] === '(' && source[i + 2] === '(') {
      i = maskBalancedRegion(source, chars, i, i + 3, '(', ')', 2);
      continue;
    }
    if (ch === '$' && source[i + 1] === '[') {
      i = maskBalancedRegion(source, chars, i, i + 2, '[', ']', 1);
      continue;
    }
    if (ch === '$' && source[i + 1] === '{') {
      i = maskBalancedRegion(source, chars, i, i + 2, '{', '}', 1);
      continue;
    }
    const atTokenBoundary = i === 0 || /\s|[;&|]/.test(source[i - 1]);
    if (atTokenBoundary && ch === '(' && source[i + 1] === '(') {
      i = maskBalancedRegion(source, chars, i, i + 2, '(', ')', 2);
      continue;
    }
    if (atTokenBoundary && ch === '[' && source[i + 1] === '[') {
      i = maskBalancedRegion(source, chars, i, i + 2, '[', ']', 2);
      continue;
    }
    if (ch === '<' && source[i + 1] === '<' && operatorIsEscaped(source, i)) {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 1;
    }
  }
  return chars.join('');
}

function normalizeHeredocDelimiter(raw) {
  const value = String(raw || '');
  let result = '';
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === quote && !isQuoteEscaped(value, i, quote)) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === '\\' && i + 1 < value.length) {
        result += value[i + 1];
        i += 1;
        continue;
      }
      result += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '$' && (value[i + 1] === '"' || value[i + 1] === "'")) {
      quote = value[i + 1];
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < value.length) {
      result += value[i + 1];
      i += 1;
      continue;
    }
    result += ch;
  }
  return result;
}

function readHeredocWord(commandLine, start) {
  let raw = '';
  let quote = null;
  let index = start;
  while (index < commandLine.length) {
    const ch = commandLine[index];
    if (quote) {
      raw += ch;
      if (ch === quote && !isQuoteEscaped(commandLine, index, quote)) quote = null;
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      raw += ch;
      index += 1;
      continue;
    }
    if (ch === '\\' && index + 1 < commandLine.length) {
      raw += ch + commandLine[index + 1];
      index += 2;
      continue;
    }
    if (/\s|[;&|<>]/.test(ch)) break;
    raw += ch;
    index += 1;
  }
  return { complete: quote === null, end: index, raw };
}

function heredocDescriptors(line) {
  const commandLine = stripShellComments(maskNonHeredocContexts(line));
  const descriptors = [];
  let quote = null;
  for (let i = 0; i < commandLine.length - 1; i += 1) {
    const ch = commandLine[i];
    if (quote) {
      if (ch === quote && !isQuoteEscaped(commandLine, i, quote)) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch !== '<' || commandLine[i + 1] !== '<') continue;
    if (commandLine[i + 2] === '<') {
      i += 2;
      continue;
    }

    let cursor = i + 2;
    let stripTabs = false;
    if (commandLine[cursor] === '-') {
      stripTabs = true;
      cursor += 1;
    }
    while (commandLine[cursor] === ' ' || commandLine[cursor] === '\t') cursor += 1;
    const word = readHeredocWord(commandLine, cursor);
    const delimiter = normalizeHeredocDelimiter(word.raw);
    if (word.complete && /^[A-Za-z0-9_.:+@%/-]+$/.test(delimiter)) {
      descriptors.push({ delimiter, stripTabs });
    }
    i = Math.max(i, word.end - 1);
  }
  return descriptors;
}

function maskInheritedQuotePrefix(line, inheritedQuote) {
  if (!inheritedQuote) return line;
  const chars = [...line];
  for (let i = 0; i < line.length; i += 1) {
    chars[i] = ' ';
    if (line[i] === inheritedQuote && !isQuoteEscaped(line, i, inheritedQuote)) break;
  }
  return chars.join('');
}

function quoteStateAfterLine(line, initialQuote) {
  let quote = initialQuote;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && !isQuoteEscaped(line, i, quote)) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (isCommentStart(line, i)) break;
  }
  return quote;
}

function stripHeredocBodies(command) {
  const lines = String(command || '').split(/\r?\n/);
  const output = [];
  const pending = [];
  const bodyBuffer = [];
  let inheritedQuote = null;
  for (const line of lines) {
    if (pending.length) {
      bodyBuffer.push(line);
      const current = pending[0];
      const candidate = current.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === current.delimiter) pending.shift();
      if (!pending.length) bodyBuffer.length = 0;
      continue;
    }
    output.push(line);
    pending.push(...heredocDescriptors(maskInheritedQuotePrefix(line, inheritedQuote)));
    inheritedQuote = quoteStateAfterLine(line, inheritedQuote);
  }
  if (pending.length) output.push(...bodyBuffer);
  return output.join('\n');
}

function collapseLineContinuations(command) {
  const source = String(command || '');
  let output = '';
  let quote = null;
  let inComment = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inComment) {
      output += ch;
      if (ch === '\r' || ch === '\n') inComment = false;
      continue;
    }

    if (quote !== "'" && (ch === '\\' || ch === '`')) {
      let cursor = i;
      while (source[cursor] === ch) cursor += 1;
      const count = cursor - i;
      const hasNewline = source[cursor] === '\n'
        || (source[cursor] === '\r' && source[cursor + 1] === '\n');
      if (hasNewline && count % 2 === 1) {
        output += ch.repeat(count - 1);
        i = source[cursor] === '\r' ? cursor + 1 : cursor;
        continue;
      }
    }

    if (quote) {
      output += ch;
      if (ch === quote && !isQuoteEscaped(source, i, quote)) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      output += ch;
      continue;
    }
    const logicalBoundary = output.length === 0
      || (/\s|[;&|]/.test(output[output.length - 1])
        && !boundaryIsEscaped(output, output.length - 1));
    if (ch === '#' && logicalBoundary) inComment = true;
    output += ch;
  }
  return output;
}

function stripShellComments(command) {
  const source = String(command || '');
  let output = '';
  let quote = null;
  let inComment = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inComment) {
      if (ch === '\r' || ch === '\n') {
        inComment = false;
        output += ch;
      }
      continue;
    }
    if (quote) {
      output += ch;
      if (ch === quote && !isQuoteEscaped(source, i, quote)) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      output += ch;
      continue;
    }
    if (isCommentStart(source, i)) {
      inComment = true;
      continue;
    }
    output += ch;
  }
  return output;
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

function unquoteToken(raw) {
  const value = String(raw || '');
  if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function optionParts(raw) {
  const option = unquoteToken(raw);
  const separator = option.indexOf('=');
  if (separator < 0) return { name: option, value: null };
  return {
    name: option.slice(0, separator),
    value: option.slice(separator + 1),
  };
}

function splitEnvString(raw) {
  return lexCommand(unquoteToken(raw));
}

function consumeCommandOptions(tokens) {
  while (tokens.length && String(tokens[0]).startsWith('-')) {
    const option = unquoteToken(tokens.shift());
    if (option === '--') break;
  }
}

function consumeSudoOptions(tokens) {
  while (tokens.length && String(tokens[0]).startsWith('-')) {
    const { name, value } = optionParts(tokens.shift());
    if (name === '--') break;
    if (SUDO_OPTIONS_WITH_VALUE.has(name) && value === null && tokens.length) {
      tokens.shift();
    }
  }
}

function consumeEnvOptions(tokens) {
  while (tokens.length && String(tokens[0]).startsWith('-')) {
    const raw = tokens.shift();
    const { name, value } = optionParts(raw);
    if (name === '--') break;

    let splitValue = value;
    if (name.startsWith('-S') && name !== '-S') {
      splitValue = unquoteToken(raw).slice(2);
    }
    if (ENV_SPLIT_OPTIONS.has(name) || (name.startsWith('-S') && name !== '-S')) {
      if (splitValue === null && tokens.length) splitValue = tokens.shift();
      if (splitValue) tokens.unshift(...splitEnvString(splitValue));
      continue;
    }

    const hasAttachedShortValue = (name.startsWith('-u') && name !== '-u')
      || (name.startsWith('-C') && name !== '-C');
    if (!hasAttachedShortValue
        && ENV_OPTIONS_WITH_VALUE.has(name)
        && value === null
        && tokens.length) {
      tokens.shift();
    }
  }
}

function segmentHead(segment) {
  const tokens = Array.isArray(segment) ? [...segment] : tokenizeSegment(segment);
  while (tokens.length) {
    while (tokens.length
        && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || /^\$env:[^=]+=/i.test(tokens[0]))) {
      tokens.shift();
    }
    const wrapper = normalizeHead(tokens[0]);
    if (wrapper === 'command') {
      tokens.shift();
      consumeCommandOptions(tokens);
      continue;
    }
    if (wrapper === 'sudo') {
      tokens.shift();
      consumeSudoOptions(tokens);
      continue;
    }
    if (tokens[0] === '&') {
      tokens.shift();
      continue;
    }
    if (wrapper === 'env') {
      tokens.shift();
      consumeEnvOptions(tokens);
      continue;
    }
    break;
  }
  return { head: normalizeHead(tokens[0]), tokens };
}

function analyzeShellCommand(command, config) {
  if (typeof command !== 'string' || !command.trim()) {
    return { safe: false, reason: 'empty shell command', heads: [] };
  }
  if (hasAmbiguousCrossShellEscape(command)) {
    return { safe: false, reason: 'cross-shell escape is ambiguous', heads: [] };
  }
  if (hasNestedShellEvaluation(command)) {
    return { safe: false, reason: 'nested shell evaluation requires delegated review', heads: [] };
  }
  const withoutHeredocBodies = stripHeredocBodies(command);
  const logicalCommand = collapseLineContinuations(withoutHeredocBodies);
  const segments = tokenSegments(stripShellComments(logicalCommand));
  if (!segments.length) return { safe: false, reason: 'no command segments', heads: [] };
  const allowedHeads = new Set((config.whitelist.shell_heads || []).map((item) => String(item).toLowerCase()));
  const heads = [];

  for (const segment of segments) {
    const parsed = segmentHead(segment);
    heads.push(parsed.head);
    if (!parsed.head) return { safe: false, reason: 'unknown command head', heads };
    // Git is an orchestration invariant, not a dispatch heuristic: the primary
    // agent executes every Git command serially, so no Git subcommand belongs
    // in the lightweight/dangerous classification below. Keep inspecting later
    // segments because a compound command may still contain non-Git work.
    if (parsed.head === 'git') continue;
    const segmentCommand = segment.join(' ');
    if (/\$\(|`|[<>]\s*\(/.test(segmentCommand)) {
      return { safe: false, reason: 'command substitution requires delegated review', heads };
    }
    if (hasAmbiguousCrossShellEscape(segmentCommand)) {
      return { safe: false, reason: 'cross-shell escape is ambiguous', heads };
    }
    if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(segmentCommand))) {
      return { safe: false, reason: 'destructive shell pattern', heads };
    }
    if (segment.some((token) => OUTPUT_REDIRECTS.has(token))) {
      return { safe: false, reason: 'shell redirection can write files', heads };
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
