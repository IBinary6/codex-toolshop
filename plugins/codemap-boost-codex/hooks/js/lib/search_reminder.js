'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { pluginDataDir } = require('./runtime');

const SEARCH_CONTEXT = 'CodeMap Boost: If this search concerns symbols, calls, dependencies, or impact, query available graph tools first, then verify against source. If you already have relevant graph evidence, are reading a known file, or are searching filenames or literal text, continue the current operation. When graph tools are unavailable or lack coverage, fall back immediately and state the basis; do not repeat build/update.';

/**
 * Recognize common search commands for a soft hint, not for permissions or the command’s actual working directory.
 * The host maps exec_command, including Code Mode inner calls, to Bash/command.
 * @example looksLikeCodeSearch({ tool_name: 'Bash', tool_input: { command: 'rg Auth src' } })
 */
function looksLikeCodeSearch(input) {
  if (!input || input.tool_name !== 'Bash') return false;
  const command = input.tool_input && input.tool_input.command;
  if (typeof command !== 'string') return false;
  // Do not execute or expand commands. Preserve quoted arguments so echoed text is not mistaken for a search.
  const tokens = command.match(/#[^\n]*|(?:"(?:\\.|[^"\\])*"|'[^']*'|\\[\s\S]|[^\s;&|'"\\])+|[;&|\n]+/g) || [];
  let commandStart = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^[;&|\n]+$/.test(token)) { commandStart = true; continue; }
    if (token.startsWith('#')) continue;
    if (!commandStart) continue;
    if (token === 'command' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    commandStart = false;
    const executable = token.replace(/^['"]|['"]$/g, '').split(/[\\/]/).pop();
    if (!/^(?:rg|grep|findstr|Select-String)(?:\.exe)?$/i.test(executable)) continue;
    const args = [];
    for (let next = index + 1; next < tokens.length && !/^[;&|\n]+$/.test(tokens[next]); next += 1) {
      if (tokens[next].startsWith('#')) break;
      args.push(tokens[next].replace(/^['"]|['"]$/g, ''));
    }
    if (args.includes('--files') || args.includes('--help') || args.includes('--version')) continue;
    // Exclude only definite document, configuration, or log targets; mixed source targets still receive a conditional hint.
    const positional = args.filter((arg) => arg && !arg.startsWith('-'));
    const targets = positional.slice(1);
    const textTarget = targets.length > 0 && targets.every((arg) => /\.(?:md|txt|log|json|toml|ya?ml|ini|csv)$/i.test(arg));
    const sourceTarget = args.some((arg) => /\.(?:[ch](?:pp|xx|c)?|cc|rs|py|[jt]sx?|go|java|cs)$/i.test(arg));
    if (textTarget && !sourceTarget) continue;
    return true;
  }
  return false;
}

/**
 * Isolate reminder state using hashes of host identifiers; do not store prompts, commands, or raw paths.
 * cwd is the session directory and need not equal exec_command workdir.
 * @example reminderPath({ session_id: 's', turn_id: 't', cwd: '/repo' })
 */
function reminderPath(input) {
  if (!input || !['session_id', 'turn_id', 'cwd'].every((key) => typeof input[key] === 'string' && input[key])) return '';
  const key = JSON.stringify([input.session_id, input.turn_id, input.cwd, input.agent_id || '']);
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(pluginDataDir(), 'search-reminders', hash);
}

/** Reset on every user follow-up, even within the same turn.@example resetSearchReminder(input) */
function resetSearchReminder(input) {
  const target = reminderPath(input);
  if (!target) return;
  try { fs.unlinkSync(target); } catch (_) {}
}

/** Atomically claim one hint for parallel searches; if state is unavailable, emit a soft hint and continue.@example claimSearchReminder(input) */
function claimSearchReminder(input) {
  const target = reminderPath(input);
  if (!target) return true;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(target, 'wx', 0o600);
    fs.closeSync(fd);
    return true;
  } catch (error) {
    return error.code !== 'EEXIST';
  }
}

module.exports = { SEARCH_CONTEXT, looksLikeCodeSearch, resetSearchReminder, claimSearchReminder };
