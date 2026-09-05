'use strict';

const fs = require('fs');
const {
  renderRecall,
  resultItems,
  runCli,
  workspaceScopeArgs,
} = require('./local_knowledge_cli');

const ERROR_PATTERN = /\b(error\s*[CE]\d{4}|LNK\d{4}|fatal error|FAILED|error\[E\d+\]|unresolved external|undefined reference|segmentation fault|access violation|ModuleNotFoundError|No module named|AssertionError|SyntaxError|TypeError|ReferenceError|command not found|not recognized)\b|Traceback \(most recent call last\)/i;
const SAVE_PATTERN = /(?:请?记住|帮我记|保存到(?:本地)?知识库|保存(?:这个|这条)(?:偏好|知识|方案)|以后(?:都|默认)|remember (?:this|that|my)|save (?:this|that|my) (?:preference|knowledge|solution))/i;
const NO_SAVE_PATTERN = /(?:不要|无需|不需要|不必|禁止|别).{0,12}(?:保存|记住|记录)|(?:只读|仅审查|先不(?:要)?修改)|\b(?:do not|don't|never)\s+(?:save|remember|store)|\bread[- ]only\b/i;
const VERIFIED_PATTERN = /(?:搞定|解决了|已修复|修好了|通过了|跑通|已确认有效|根因是|方案定下来了)|(?:\bfixed\b|\bresolved\b|\bworks now\b|\btests? pass(?:ed)?\b|\bbuild pass(?:ed)?\b)/i;

function readInput() {
  /** 读取 Codex UserPromptSubmit JSON；损坏输入不影响主流程。 */
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return null; }
}

function emit(additionalContext) {
  /** 输出 Codex UserPromptSubmit 的附加上下文。 */
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }));
}

function recall(prompt, input) {
  /** 用原始提示进行一次作用域化召回，不改写 query 或使用不相关兜底。 */
  const payload = Buffer.from(prompt, 'utf8').toString('base64');
  return runCli(['recall', '--query-b64', payload, '--occasion', 'turn',
    ...workspaceScopeArgs(input), '--limit', '3', '--max-chars', '2200']);
}

function main() {
  /** 召回与提示相关的知识；关键词只提供候选提示，不能授予写入权限。 */
  const input = readInput();
  const prompt = input && typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) return;

  const contexts = [];
  const configuredMode = (process.env.LOCAL_KNOWLEDGE_SAVE_HINTS || 'verified').toLowerCase();
  const mode = ['off', 'explicit', 'verified'].includes(configuredMode) ? configuredMode : 'off';
  if (mode !== 'off' && !NO_SAVE_PATTERN.test(prompt)
      && (SAVE_PATTERN.test(prompt) || (mode === 'verified' && VERIFIED_PATTERN.test(prompt)))) {
    contexts.push('[LOCAL_KNOWLEDGE_SAVE_HINT] 关键词可能涉及长期保存或已验证方案，'
      + '不构成保存授权或验证证据。结合用户原意、当前任务范围和宿主记忆策略判断；'
      + '仅在允许写入且信息已核实、有复用价值时使用 local-knowledge-save。'
      + '只读要求、否定、引用、保存项目文件均不能当作记忆写入请求；无需为可选保存打断主任务。');
  }

  const data = recall(prompt, input);
  const items = resultItems(data);
  if (items.length > 0) {
    contexts.push(renderRecall(items, 'turn'));
  } else if (ERROR_PATTERN.test(prompt)) {
    contexts.push(data && Array.isArray(data.results)
      ? '[LOCAL_KNOWLEDGE_RECALL_HINT] 已用原始错误自动查询本地知识库但没有命中。继续正常排查，无需改写查询重复召回。'
      : '[LOCAL_KNOWLEDGE_RECALL_HINT] 本地知识召回未完成，不能判断是否有历史记录。继续正常排查；需要诊断时使用 local-knowledge-setup。');
  }
  if (contexts.length > 0) emit(contexts.join('\n\n'));
}

try { main(); } catch (_) {}
