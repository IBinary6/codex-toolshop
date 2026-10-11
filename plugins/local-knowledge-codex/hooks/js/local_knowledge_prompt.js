'use strict';

const fs = require('fs');
const {
  renderRecall,
  resultItems,
  runCli,
  workspaceScopeArgs,
} = require('./local_knowledge_cli');

const ERROR_PATTERN = /\b(error\s*[CE]\d{4}|LNK\d{4}|fatal error|FAILED|error\[E\d+\]|unresolved external|undefined reference|segmentation fault|access violation|ModuleNotFoundError|No module named|AssertionError|SyntaxError|TypeError|ReferenceError|command not found|not recognized)\b|Traceback \(most recent call last\)/i;
const SAVE_PATTERN = /(?:\u8bf7?\u8bb0\u4f4f|\u5e2e\u6211\u8bb0|\u4fdd\u5b58\u5230(?:\u672c\u5730)?\u77e5\u8bc6\u5e93|\u4fdd\u5b58(?:\u8fd9\u4e2a|\u8fd9\u6761)(?:\u504f\u597d|\u77e5\u8bc6|\u65b9\u6848)|\u4ee5\u540e(?:\u90fd|\u9ed8\u8ba4)|remember (?:this|that|my)|save (?:this|that|my) (?:preference|knowledge|solution))/i;
const NO_SAVE_PATTERN = /(?:\u4e0d\u8981|\u65e0\u9700|\u4e0d\u9700\u8981|\u4e0d\u5fc5|\u7981\u6b62|\u522b).{0,12}(?:\u4fdd\u5b58|\u8bb0\u4f4f|\u8bb0\u5f55)|(?:\u53ea\u8bfb|\u4ec5\u5ba1\u67e5|\u5148\u4e0d(?:\u8981)?\u4fee\u6539)|\b(?:do not|don't|never)\s+(?:save|remember|store)|\bread[- ]only\b/i;
const VERIFIED_PATTERN = /(?:\u641e\u5b9a|\u89e3\u51b3\u4e86|\u5df2\u4fee\u590d|\u4fee\u597d\u4e86|\u901a\u8fc7\u4e86|\u8dd1\u901a|\u5df2\u786e\u8ba4\u6709\u6548|\u6839\u56e0\u662f|\u65b9\u6848\u5b9a\u4e0b\u6765\u4e86)|(?:\bfixed\b|\bresolved\b|\bworks now\b|\btests? pass(?:ed)?\b|\bbuild pass(?:ed)?\b)/i;

function readInput() {
  /** Read Codex UserPromptSubmit JSON; invalid input does not affect the main flow. */
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return null; }
}

function emit(additionalContext) {
  /** Emit additional context for Codex UserPromptSubmit. */
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }));
}

function recall(prompt, input) {
  /** Recall once within scope using the original prompt, without rewriting the query or using unrelated fallback. */
  const payload = Buffer.from(prompt, 'utf8').toString('base64');
  return runCli(['recall', '--query-b64', payload, '--occasion', 'turn',
    ...workspaceScopeArgs(input), '--limit', '3', '--max-chars', '2200']);
}

function main() {
  /** Recall knowledge relevant to the prompt; keywords only suggest candidates and never authorize a write. */
  const input = readInput();
  const prompt = input && typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) return;

  const contexts = [];
  const configuredMode = (process.env.LOCAL_KNOWLEDGE_SAVE_HINTS || 'verified').toLowerCase();
  const mode = ['off', 'explicit', 'verified'].includes(configuredMode) ? configuredMode : 'off';
  if (mode !== 'off' && !NO_SAVE_PATTERN.test(prompt)
      && (SAVE_PATTERN.test(prompt) || (mode === 'verified' && VERIFIED_PATTERN.test(prompt)))) {
    contexts.push('[LOCAL_KNOWLEDGE_SAVE_HINT] Keywords may suggest long-term saving or a verified fix, '
      + 'but are neither save authorization nor verification evidence. Apply the user intent, current scope, and host memory policy. '
      + 'Use local-knowledge-save only when writing is permitted and the information is verified and reusable. '
      + 'Read-only requests, negation, quotations, and saving project files are not memory-write requests; do not interrupt the main task for optional saving.');
  }

  const data = recall(prompt, input);
  const items = resultItems(data);
  if (items.length > 0) {
    contexts.push(renderRecall(items, 'turn'));
  } else if (ERROR_PATTERN.test(prompt)) {
    contexts.push(data && Array.isArray(data.results)
      ? '[LOCAL_KNOWLEDGE_RECALL_HINT] Automatic local knowledge search with the original error found no match. Continue normal diagnosis without repeated query rewrites.'
      : '[LOCAL_KNOWLEDGE_RECALL_HINT] Local knowledge recall did not finish, so historical matches are unknown. Continue normal diagnosis; use local-knowledge-setup if diagnostics are needed.');
  }
  if (contexts.length > 0) emit(contexts.join('\n\n'));
}

try { main(); } catch (_) {}
