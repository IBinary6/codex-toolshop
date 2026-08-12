'use strict';

const { spawnSync } = require('child_process');

const MIN_MAJOR = 3;
const MIN_MINOR = 11;

function pythonCandidates() {
  if (process.env.BUGDB_PYTHON) return [process.env.BUGDB_PYTHON];
  return process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
}

function detectPython() {
  /** 检测可运行 BugDB 核心的 Python 版本，不修改环境。 */
  for (const command of pythonCandidates()) {
    const args = command === 'py' ? ['-3'] : [];
    const result = spawnSync(command, [...args, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: process.platform === 'win32',
      timeout: 3000,
    });
    if (result.error || result.status !== 0) continue;
    const match = String(result.stdout || '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) continue;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return { ok: major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR), version: match[0] };
  }
  return { ok: false, version: null };
}

function main() {
  const detected = detectPython();
  if (detected.ok) return;
  const where = detected.version ? `检测到 Python ${detected.version}（低于 3.11）` : '未检测到可用 Python';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `[BUGDB_SETUP_HINT] BugDB 需要 Python 3.11+，当前${where}。请运行 bugdb-setup skill 检查环境；自动查询会静默跳过，不影响其它工作。`,
    },
  }));
}

try { main(); } catch (_) {}
