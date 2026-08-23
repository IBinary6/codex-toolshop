'use strict';

const fs = require('fs');
const {
  renderRecall,
  resultItems,
  runCli,
  workspaceScopeArgs,
} = require('./local_knowledge_cli');

const ERROR_PATTERN = /\b(error\s*[CE]\d{4}|LNK\d{4}|fatal error|FAILED|error\[E\d+\]|unresolved external|undefined reference|segmentation fault|access violation|ModuleNotFoundError|No module named|AssertionError|SyntaxError|TypeError|ReferenceError|command not found|not recognized)\b|Traceback \(most recent call last\)/i;
const SAVE_PATTERN = /(?:请?记住|帮我记|保存(?:这个|这条|一下)?|以后(?:都|默认)|我的偏好|remember (?:this|that|my)|save (?:this|that|my))/i;
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

function recall(prompt) {
  /** 用原始提示进行一次作用域化召回，不改写 query 或使用不相关兜底。 */
  const payload = Buffer.from(prompt, 'utf8').toString('base64');
  return runCli(['recall', '--query-b64', payload, '--occasion', 'turn',
    ...workspaceScopeArgs(), '--limit', '3', '--max-chars', '2200']);
}

function main() {
  /** 识别显式保存意图，并为其它提示召回真正相关的本地知识。 */
  const input = readInput();
  const prompt = input && typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) return;

  if (SAVE_PATTERN.test(prompt)) {
    emit('[LOCAL_KNOWLEDGE_SAVE_HINT] 用户明确要求记住信息。调用 local-knowledge-save skill，'
      + '选择正确的 kind、scope、recall_policy 和 cues 后显式保存；密码、令牌、私钥等凭据不得写入。');
    return;
  }
  if (VERIFIED_PATTERN.test(prompt)) {
    emit('[LOCAL_KNOWLEDGE_SAVE_HINT] 当前提示可能表示方案或事实已经验证。若具有复用价值，'
      + '调用 local-knowledge-save skill 去重保存；仍是猜测或一次性信息时不要写入。');
    return;
  }

  const items = resultItems(recall(prompt));
  if (items.length > 0) {
    emit(renderRecall(items, 'turn'));
    return;
  }
  if (ERROR_PATTERN.test(prompt)) {
    emit('[LOCAL_KNOWLEDGE_RECALL_HINT] 已用原始错误自动查询本地知识库但没有命中。'
      + '继续正常排查，无需改写查询重复召回。');
  }
}

try { main(); } catch (_) {}
