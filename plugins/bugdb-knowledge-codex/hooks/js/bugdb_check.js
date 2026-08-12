'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ERROR_PATTERN = /\b(error\s*[CE]\d{4}|LNK\d{4}|fatal error|FAILED|error\[E\d+\]|unresolved external|undefined reference|segmentation fault|access violation|ModuleNotFoundError|No module named|AssertionError|SyntaxError|TypeError|ReferenceError|command not found|not recognized)\b|Traceback \(most recent call last\)/i;

function readStdin() {
  /** 读取 Codex PostToolUse JSON；输入损坏时返回空对象。 */
  try { return JSON.parse(require('fs').readFileSync(0, 'utf8')); } catch (_) { return null; }
}

function outputText(input) {
  /** 适配 Codex 的 tool_output/output/error 字段；不依赖 Claude hook payload。 */
  if (!input) return '';
  const values = [input.tool_output, input.tool_response, input.output, input.error, input.result];
  return values.map(collectText).filter(Boolean).join('\n').slice(0, 200000);
}

function collectText(value, depth = 0) {
  /** 提取字符串、content 数组及 stdout/stderr 等 Codex 结构化输出。 */
  if (typeof value === 'string') return value;
  if (value == null || depth > 6) return '';
  if (Array.isArray(value)) {
    return value.map((item) => collectText(item, depth + 1)).filter(Boolean).join('\n');
  }
  if (typeof value !== 'object') return '';
  const fields = ['text', 'stdout', 'stderr', 'output', 'error', 'message', 'content', 'result'];
  return fields.map((field) => collectText(value[field], depth + 1)).filter(Boolean).join('\n');
}

function pythonCandidates() {
  if (process.env.BUGDB_PYTHON) return [{ command: process.env.BUGDB_PYTHON, args: [] }];
  return process.platform === 'win32'
    ? [{ command: 'python', args: [] }, { command: 'python3', args: [] }, { command: 'py', args: ['-3'] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
}

function runSearch(query) {
  const root = path.resolve(process.env.PLUGIN_ROOT || path.join(__dirname, '..', '..'));
  const cli = path.join(root, 'bugdb', 'cli.py');
  const payload = Buffer.from(query, 'utf8').toString('base64');
  for (const candidate of pythonCandidates()) {
    const result = spawnSync(candidate.command, [...candidate.args, cli, 'search', '--query-b64', payload, '--format', 'json', '--no-fallback'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: process.platform === 'win32',
      timeout: 4000,
      env: { ...process.env, BUGDB_HOME: process.env.BUGDB_HOME || undefined },
    });
    if (result.error || result.status !== 0 || !result.stdout) continue;
    try { return JSON.parse(result.stdout); } catch (_) {}
  }
  return null;
}

function main() {
  const input = readStdin();
  const output = outputText(input);
  if (!output || input && input.is_interrupt === true) return;
  const line = output.split(/\r?\n/).find((item) => ERROR_PATTERN.test(item));
  if (!line) return;
  const data = runSearch(line);
  if (!data || !Array.isArray(data.results) || data.results.length === 0) return;
  const top = data.results[0];
  const steps = JSON.stringify(top.action_steps || []);
  const additionalContext = `[BUGDB_MATCH] id=${top.id} confidence=${top.confidence} status=${top.status}\n`
    + `entry_kind=${top.entry_kind}\ncategory=${top.category}\ncontent=${String(top.content || '').replace(/\r?\n/g, ' ')}\n`
    + `steps=${steps}\nhint=如方案无效，忽略此提示继续正常排查`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
  }));
}

try { main(); } catch (_) {}
