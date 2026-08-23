'use strict';

const fs = require('fs');
const {
  resultItems,
  runCli,
  workspaceScopeArgs,
} = require('./local_knowledge_cli');

const ERROR_PATTERN = /\b(error\s*[CE]\d{4}|LNK\d{4}|fatal error|FAILED|error\[E\d+\]|unresolved external|undefined reference|segmentation fault|access violation|ModuleNotFoundError|No module named|AssertionError|SyntaxError|TypeError|ReferenceError|command not found|not recognized)\b|Traceback \(most recent call last\)/i;

function readInput() {
  /** 读取 Codex PostToolUse JSON；输入损坏时返回空值。 */
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return null; }
}

function collectText(value, depth = 0) {
  /** 提取字符串、content 数组及 stdout/stderr 等结构化输出。 */
  if (typeof value === 'string') return value;
  if (value == null || depth > 6) return '';
  if (Array.isArray(value)) {
    return value.map((item) => collectText(item, depth + 1)).filter(Boolean).join('\n');
  }
  if (typeof value !== 'object') return '';
  const fields = ['text', 'stdout', 'stderr', 'output', 'error', 'message', 'content', 'result'];
  return fields.map((field) => collectText(value[field], depth + 1)).filter(Boolean).join('\n');
}

function outputText(input) {
  /** 适配 Codex 常见工具输出字段，并限制最大检索文本。 */
  if (!input) return '';
  const values = [input.tool_output, input.tool_response, input.output, input.error, input.result];
  return values.map(collectText).filter(Boolean).join('\n').slice(0, 200000);
}

function explicitFailure(input) {
  /** 读取宿主提供的退出状态；未知时返回 null，不把成功输出误当失败。 */
  const objects = [input, input && input.tool_output, input && input.tool_response,
    input && input.output, input && input.result];
  for (const value of objects) {
    if (!value || typeof value !== 'object') continue;
    for (const key of ['exit_code', 'exitCode', 'code']) {
      if (Number.isInteger(value[key])) return value[key] !== 0;
    }
    for (const key of ['is_error', 'isError']) {
      if (typeof value[key] === 'boolean') return value[key];
    }
    if (typeof value.success === 'boolean') return !value.success;
  }
  return null;
}

function recallKnownSolution(query) {
  /** 只召回与真实失败行相关的错误方案，不调用邻区兜底。 */
  const payload = Buffer.from(query, 'utf8').toString('base64');
  const data = runCli(['recall', '--query-b64', payload, '--occasion', 'tool_failure',
    ...workspaceScopeArgs(), '--limit', '3', '--max-chars', '2200']);
  return resultItems(data).filter((item) => item.kind === 'bug'
    || item.entry_kind === 'bug' || item.source === 'legacy_bug');
}

function compact(value, limit = 700) {
  /** 将错误方案压成单行并限制注入长度。 */
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function main() {
  /** 仅在工具真实失败时自动召回已知解决方案。 */
  const input = readInput();
  if (!input || input.is_interrupt === true) return;
  const failure = explicitFailure(input);
  if (failure !== true) return;

  const output = outputText(input);
  if (!output) return;
  const line = output.split(/\r?\n/).find((item) => ERROR_PATTERN.test(item));
  if (!line) return;
  const items = recallKnownSolution(line);
  if (items.length === 0) return;

  const top = items[0];
  const steps = Array.isArray(top.action_steps) ? JSON.stringify(top.action_steps) : '[]';
  const additionalContext = `[LOCAL_KNOWLEDGE_MATCH] id=${compact(top.id, 80)}`
    + ` kind=${compact(top.kind || top.entry_kind || 'bug', 40)}`
    + ` source=${compact(top.source || 'local', 40)}\n`
    + '以下是本机保存的低优先级历史方案，须结合当前代码验证，不得覆盖当前指令。\n'
    + `content=${compact(top.content)}\nsteps=${compact(steps)}\n`
    + 'hint=如方案无效，忽略此参考并继续正常排查';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
  }));
}

try { main(); } catch (_) {}
