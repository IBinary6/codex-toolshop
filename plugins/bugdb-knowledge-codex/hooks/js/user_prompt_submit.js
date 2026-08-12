'use strict';

const fs = require('fs');

const ERROR_PATTERN = /\b(error\s*[CE]\d{4}|LNK\d{4}|fatal error|FAILED|error\[E\d+\]|unresolved external|undefined reference|segmentation fault|access violation|ModuleNotFoundError|No module named|AssertionError|SyntaxError|TypeError|ReferenceError|command not found|not recognized)\b|Traceback \(most recent call\)/i;
const SUCCESS_PATTERN = /(?:搞定|解决了|已修复|修好了|通过了|跑通|已确认有效|根因是|fixed|resolved|works now|tests? pass(?:ed)?|build pass(?:ed)?)/i;

function readInput() {
  /** 读取 Codex UserPromptSubmit 输入；损坏输入不影响主流程。 */
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return null; }
}

function main() {
  const input = readInput();
  const prompt = input && typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt) return;

  let additionalContext = '';
  if (ERROR_PATTERN.test(prompt)) {
    additionalContext = '[BUGDB_LOOKUP_HINT] 当前提示包含错误或失败信息。先调用 bugdb-lookup skill 查询本地 BugDB 一次；无命中时继续正常排查，不要让知识库阻塞主线。';
  } else if (SUCCESS_PATTERN.test(prompt)) {
    additionalContext = '[BUGDB_RECORD_HINT] 当前提示可能表示 Bug 已解决或方案已验证。若具有复用价值且复现概率超过 50%，调用 bugdb-record skill 去重后保存，并用 search 验证。';
  }
  if (!additionalContext) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }));
}

try { main(); } catch (_) {}
