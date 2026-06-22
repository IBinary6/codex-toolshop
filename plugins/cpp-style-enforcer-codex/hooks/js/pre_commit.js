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
const PRE_COMMIT_DEADLINE_MS = 25000;

/**
 * 收紧正则判定真正的 `git commit`：
 * - 命令以 git 开头（允许前导空白），后接 commit 作为独立子命令（词边界）。
 * - 排除 commit-graph / commit-tree（连字符后缀）与 echo/字符串包裹（命令必须以 git 起头）。
 * - 存疑一律返回 false（放行，不阻止）。
 * @param {string} command
 * @returns {boolean}
 */
function tokenizeCommand(command) {
  return String(command).trim().match(/(?:"[^"]*"|'[^']*'|\S+)/g) || [];
}

function unquote(token) {
  return String(token).replace(/^(['"])(.*)\1$/, '$2');
}

function normalizedCommandTokens(segment) {
  let tokens = tokenizeCommand(segment);
  while (tokens.length > 0) {
    const head = unquote(tokens[0]).toLowerCase();
    if (head === 'command' || head === '&') {
      tokens = tokens.slice(1);
      continue;
    }
    if ((head === 'cmd' || head === 'cmd.exe') && tokens.length >= 3 && unquote(tokens[1]).toLowerCase() === '/c') {
      return tokenizeCommand(tokens.slice(2).map(unquote).join(' '));
    }
    return tokens;
  }
  return tokens;
}

function gitSubcommand(tokens) {
  if (tokens.length === 0 || unquote(tokens[0]) !== 'git') return null;
  let i = 1;
  while (i < tokens.length) {
    const tok = unquote(tokens[i]);
    if (tok === '-C' || tok === '-c' || tok === '--git-dir' || tok === '--work-tree') {
      i += 2;
      continue;
    }
    if (tok.startsWith('--git-dir=') || tok.startsWith('--work-tree=')) {
      i += 1;
      continue;
    }
    if (tok.startsWith('-')) {
      i += 1;
      continue;
    }
    return tok;
  }
  return null;
}

function segmentIsGitCommit(segment) {
  const tokens = normalizedCommandTokens(segment);
  if (tokens.length === 0) return false;
  return gitSubcommand(tokens) === 'commit';
}

function gitCommitCwdFromTokens(tokens, cwd) {
  if (tokens.length === 0 || unquote(tokens[0]) !== 'git') return null;
  let current = path.resolve(cwd);
  let i = 1;
  while (i < tokens.length) {
    const tok = unquote(tokens[i]);
    if (tok === '-C') {
      if (i + 1 >= tokens.length) return null;
      current = path.resolve(current, unquote(tokens[i + 1]));
      i += 2;
      continue;
    }
    if (tok === '-c' || tok === '--git-dir' || tok === '--work-tree') {
      i += 2;
      continue;
    }
    if (tok.startsWith('--git-dir=') || tok.startsWith('--work-tree=')) {
      i += 1;
      continue;
    }
    if (tok.startsWith('-')) {
      i += 1;
      continue;
    }
    return tok === 'commit' ? current : null;
  }
  return null;
}

function commitCwd(command, baseCwd = process.cwd()) {
  if (typeof command !== 'string') return null;
  let current = path.resolve(baseCwd);
  for (const segment of command.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
    const tokens = normalizedCommandTokens(segment);
    if (tokens.length === 0) continue;
    const head = unquote(tokens[0]).toLowerCase();
    if (head === 'cd' && tokens.length >= 2) {
      current = path.resolve(current, unquote(tokens[1]));
      continue;
    }
    const target = gitCommitCwdFromTokens(tokens, current);
    if (target) return target;
  }
  return null;
}

function isGitCommit(command) {
  return commitCwd(command) !== null;
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
  const baseCwd = input.cwd ? path.resolve(input.cwd) : process.cwd();
  const cwd = commitCwd(command, baseCwd);
  if (!cwd) return passSilent();

  // loadConfig/findProjectConfig 从 path.dirname(filePath) 向上找；传 cwd 下的探针文件，
  // 使其 dirname 落在 cwd，从而包含 cwd 本身的 .codex-cpp-style/cpp-style.json。
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
  const deadline = Date.now() + PRE_COMMIT_DEADLINE_MS;
  for (const f of files) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 1000) {
      allViolations.push({
        file: path.relative(root, f),
        line: 0,
        category: 'runtime/timeout',
        message: 'pre-commit cpplint 总耗时超限，剩余文件未检查',
      });
      break;
    }
    try {
      const v = runCpplint(f, { root, suppressCopyright, timeoutMs: Math.min(15000, remainingMs) });
      for (const item of v) allViolations.push({ ...item, file: path.relative(root, f) });
      if (v.some((item) => item.category === 'runtime/timeout')) break;
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

module.exports = { isGitCommit, stagedCppFiles, tokenizeCommand, gitSubcommand, commitCwd };
