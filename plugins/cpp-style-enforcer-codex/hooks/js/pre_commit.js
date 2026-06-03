'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const { readStdinJson } = require('./lib/stdin');
const { passSilent, denyTool, diag } = require('./lib/protocol');
const { loadConfig } = require('./lib/config');
const { repoRoot, isNew } = require('./lib/git');
const { shouldHandle } = require('./lib/target');
const { runCpplint, formatViolations } = require('./steps/cpplint');

const isWindows = process.platform === 'win32';

/**
 * 收紧正则判定真正的 `git commit`：
 * - 命令以 git 开头（允许前导空白），后接 commit 作为独立子命令（词边界）。
 * - 排除 commit-graph / commit-tree（连字符后缀）与 echo/字符串包裹（命令必须以 git 起头）。
 * - 存疑一律返回 false（放行，不阻止）。
 * @param {string} command
 * @returns {boolean}
 */
function isGitCommit(command) {
  if (typeof command !== 'string') return false;
  // ^\s*git\s+commit  且 commit 后不接连字符/字母数字（排除 commit-graph/commit-tree），后接空白/结尾/选项
  return /^\s*git\s+commit(?![-\w])/.test(command);
}

/**
 * 暂存区 C++ 文件（--diff-filter=ACM），过滤扩展名/排除目录。
 * @param {string} root
 * @returns {string[]} 绝对路径数组
 */
function stagedCppFiles(root) {
  const r = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
    cwd: root, encoding: 'utf-8', timeout: 5000, windowsHide: isWindows,
  });
  if (r.error || r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rel) => path.resolve(root, rel))
    .filter((abs) => shouldHandle(abs));
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 5000 });
  if (!input) return passSilent();

  const command = input.tool_input && input.tool_input.command;
  if (!isGitCommit(command)) return passSilent();

  const cwd = process.cwd();
  // loadConfig/findProjectConfig 从 path.dirname(filePath) 向上找；传 cwd 下的探针文件，
  // 使其 dirname 落在 cwd，从而包含 cwd 本身的 .claude-cpp-style/cpp-style.json。
  const config = loadConfig(path.join(cwd, '.cpp-style-probe'));
  if (config.enabled === false || !config.checks.cpplint) return passSilent();

  const root = repoRoot(cwd);
  if (!root) return passSilent();

  let files = stagedCppFiles(root);
  if (config.mode === 'incremental') {
    files = files.filter((f) => isNew(f, root) !== false);
  }
  if (files.length === 0) return passSilent();

  const suppressCopyright = !(config.copyrightInfo && config.copyrightInfo.company) || config.checks.copyright === false;
  const allViolations = [];
  for (const f of files) {
    try {
      const v = runCpplint(f, { root, suppressCopyright });
      for (const item of v) allViolations.push({ ...item, file: path.relative(root, f) });
    } catch (e) {
      diag(`pre_commit cpplint 跳过 ${f}: ${e && e.message ? e.message : e}`);
    }
  }

  // 一律硬违规：暂存文件存在任何 cpplint 违规即拦截提交。
  if (allViolations.length > 0) {
    return denyTool('提交被阻止：暂存的 C++ 文件存在 cpplint 违规。\n' + formatViolations(allViolations));
  }
  return passSilent();
}

// 仅作为 hook 入口直接执行时运行流水线；被 require（测试）时只导出函数，避免读 stdin 挂死。
if (require.main === module) {
  main().catch((e) => {
    try { diag(`pre_commit 顶层异常兜底 passSilent: ${e && e.message ? e.message : e}`); } catch (_) {}
    passSilent();
  });
}

module.exports = { isGitCommit, stagedCppFiles };
