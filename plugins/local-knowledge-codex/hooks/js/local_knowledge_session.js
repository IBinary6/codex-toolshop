'use strict';

const {
  detectPython,
  renderRecall,
  resultItems,
  runCli,
  workspaceScopeArgs,
} = require('./local_knowledge_cli');

function emit(additionalContext) {
  /** 输出 Codex SessionStart 的附加上下文。 */
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
}

function main() {
  /** 检查运行时并在会话开始时加载当前作用域的常驻知识。 */
  const detected = detectPython();
  if (!detected.ok) {
    const where = detected.version
      ? `检测到 Python ${detected.version}（低于 3.11）`
      : '未检测到可用 Python';
    emit(`[LOCAL_KNOWLEDGE_SETUP_HINT] Local Knowledge 需要 Python 3.11+，当前${where}。`
      + '请运行 local-knowledge-setup skill 检查环境；召回失败不会阻塞其它工作。');
    return;
  }

  const data = runCli(['recall', '--occasion', 'session_start',
    ...workspaceScopeArgs(), '--no-legacy-bugs', '--limit', '5', '--max-chars', '2500']);
  const items = resultItems(data);
  if (items.length > 0) emit(renderRecall(items, 'session_start'));
}

try { main(); } catch (_) {}
