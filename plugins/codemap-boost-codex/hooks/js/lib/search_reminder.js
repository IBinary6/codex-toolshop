'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { pluginDataDir } = require('./runtime');

const SEARCH_CONTEXT = 'CodeMap Boost：如果本次搜索用于符号、调用、依赖或影响面，先查询可用的图工具，再读源码核对；已取得相关图证据、已知文件读取、文件名或纯文本检索可继续当前操作。图不可用或不覆盖时直接降级并说明依据；不要重复 build/update。';

/**
 * 识别常见搜索命令；只是软提示，不据此判断权限或命令的实际工作目录。
 * 宿主将 exec_command（包括 Code Mode 内层调用）映射为 Bash/command。
 * @example looksLikeCodeSearch({ tool_name: 'Bash', tool_input: { command: 'rg Auth src' } })
 */
function looksLikeCodeSearch(input) {
  if (!input || input.tool_name !== 'Bash') return false;
  const command = input.tool_input && input.tool_input.command;
  if (typeof command !== 'string') return false;
  // 不执行或展开命令。保留带引号的参数，避免把 echo 的文本当成搜索命令。
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
    // 仅排除明确的文档/配置/日志文件目标；混合源码目标仍给出条件式提醒。
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
 * 只用宿主标识散列隔离提醒状态，不保存提示词、命令或原始路径。
 * cwd 是会话目录，不保证等于 exec_command 的 workdir。
 * @example reminderPath({ session_id: 's', turn_id: 't', cwd: '/repo' })
 */
function reminderPath(input) {
  if (!input || !['session_id', 'turn_id', 'cwd'].every((key) => typeof input[key] === 'string' && input[key])) return '';
  const key = JSON.stringify([input.session_id, input.turn_id, input.cwd, input.agent_id || '']);
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(pluginDataDir(), 'search-reminders', hash);
}

/** 每条用户补充消息都复位，即使仍在同一个 turn 内。@example resetSearchReminder(input) */
function resetSearchReminder(input) {
  const target = reminderPath(input);
  if (!target) return;
  try { fs.unlinkSync(target); } catch (_) {}
}

/** 并行搜索原子领取一次提醒；状态不可用时软提示并放行。@example claimSearchReminder(input) */
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
