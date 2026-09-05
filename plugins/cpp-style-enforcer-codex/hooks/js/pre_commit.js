'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const { readStdinJson } = require('./lib/stdin');
const { passSilent, denyTool, diag } = require('./lib/protocol');
const { loadConfig } = require('./lib/config');
const { repoRoot, isNew } = require('./lib/git');
const { createStagedSnapshot } = require('./lib/staged_snapshot');
const { shouldHandle } = require('./lib/target');
const { runCpplint, formatViolations } = require('./steps/cpplint');

const isWindows = process.platform === 'win32';
const PRE_COMMIT_DEADLINE_MS = 25000;

/**
 * 将 shell 命令拆成 token，供后续判定真正的 `git commit`：
 * - Git 可执行文件允许大小写差异、git.exe、绝对路径和常见包装命令。
 * - commit 必须是独立子命令，排除 commit-graph、commit-tree 和 echo 中的字符串。
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

/**
 * 按未被引号包裹的 shell 连接符拆分命令，保留 `cmd /c "... && ..."` 的内部结构。
 *
 * @param {string} command 原始命令
 * @returns {string[]} 顺序命令片段
 * @example
 * splitCommandSegments('cd repo && git commit') // ['cd repo', 'git commit']
 */
function splitCommandSegments(command) {
  const text = String(command);
  const segments = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const pair = text.slice(index, index + 2);
    const separatorLength = pair === '&&' || pair === '||' ? 2
      : (char === ';' || char === '|' ? 1 : 0);
    if (!separatorLength) continue;
    const segment = text.slice(start, index).trim();
    if (segment) segments.push(segment);
    index += separatorLength - 1;
    start = index + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

/**
 * 提取命令路径的文件名并统一为小写，同时兼容 POSIX 与 Windows 分隔符。
 *
 * @param {string} token 命令 token
 * @returns {string} 规范化后的命令名
 * @example
 * commandName('C:\\Program Files\\Git\\cmd\\git.exe') // 'git.exe'
 */
function commandName(token) {
  const parts = unquote(token).split(/[\\/]/);
  return String(parts[parts.length - 1] || '').toLowerCase();
}

/**
 * 判断 token 是否为 Git 可执行文件，接受 git、git.exe 和它们的绝对路径。
 *
 * @param {string} token 命令 token
 * @returns {boolean} 是否为 Git 可执行文件
 * @example
 * isGitExecutable('/usr/bin/git') // true
 */
function isGitExecutable(token) {
  const name = commandName(token);
  return name === 'git' || name === 'git.exe';
}

function normalizedCommandTokens(segment) {
  let tokens = tokenizeCommand(segment);
  while (tokens.length > 0) {
    const head = commandName(tokens[0]);
    if (head === 'command' || head === '&') {
      tokens = tokens.slice(1);
      continue;
    }
    return tokens;
  }
  return tokens;
}

/**
 * 提取 Windows `cmd[.exe] ... /c <command>` 的被包装命令；非 cmd 包装返回 null。
 *
 * @param {string} segment 单个外层命令片段
 * @returns {string|null} 被包装命令
 * @example
 * cmdWrappedCommand('cmd.exe /d /s /c git commit') // 'git commit'
 */
function cmdWrappedCommand(segment) {
  const tokens = tokenizeCommand(segment);
  if (tokens.length === 0 || !['cmd', 'cmd.exe'].includes(commandName(tokens[0]))) return null;
  const commandIndex = tokens.findIndex((token, index) => (
    index > 0 && unquote(token).toLowerCase() === '/c'
  ));
  if (commandIndex < 0 || commandIndex + 1 >= tokens.length) return '';
  const wrapped = tokens.slice(commandIndex + 1);
  return wrapped.length === 1 ? unquote(wrapped[0]) : wrapped.join(' ');
}

function gitSubcommand(tokens) {
  if (tokens.length === 0 || !isGitExecutable(tokens[0])) return null;
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
    return tok.toLowerCase();
  }
  return null;
}

function segmentIsGitCommit(segment) {
  const tokens = normalizedCommandTokens(segment);
  if (tokens.length === 0) return false;
  return gitSubcommand(tokens) === 'commit';
}

function gitCommitCwdFromTokens(tokens, cwd) {
  if (tokens.length === 0 || !isGitExecutable(tokens[0])) return null;
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
    return tok.toLowerCase() === 'commit' ? current : null;
  }
  return null;
}

function commitCwd(command, baseCwd = process.cwd()) {
  if (typeof command !== 'string') return null;
  let current = path.resolve(baseCwd);
  for (const segment of splitCommandSegments(command)) {
    const wrapped = cmdWrappedCommand(segment);
    if (wrapped !== null) {
      if (!wrapped) continue;
      const nestedTarget = commitCwd(wrapped, current);
      if (nestedTarget) return nestedTarget;
      continue;
    }
    const tokens = normalizedCommandTokens(segment);
    if (tokens.length === 0) continue;
    const head = commandName(tokens[0]);
    if (head === 'cd' && tokens.length >= 2) {
      const targetIndex = unquote(tokens[1]).toLowerCase() === '/d' ? 2 : 1;
      if (targetIndex >= tokens.length) return null;
      current = path.resolve(current, unquote(tokens[targetIndex]));
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
 * 通过 Git `-z` 列出暂存区 C++ 文件（--diff-filter=ACM），按 NUL 边界保留原文件名。
 * @param {string} root
 * @returns {string[]} 绝对路径数组
 */
function stagedCppFiles(root, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  let r;
  try {
    r = spawn('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACM'], {
      cwd: root,
      encoding: null,
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: isWindows,
    });
  } catch (error) {
    throw new Error(`git diff --cached 启动失败：${error && error.message ? error.message : error}`);
  }
  if (!r || r.error || r.status !== 0) {
    const reason = r && r.error
      ? (r.error.code || r.error.message)
      : `退出码 ${r && r.status !== undefined ? r.status : '未知'}`;
    throw new Error(`git diff --cached 无法枚举暂存区：${reason}`);
  }
  if (!r.stdout) return [];
  return Buffer.from(r.stdout)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((rel) => path.resolve(root, ...rel.split('/')))
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
  if (config.enabled === false || (!config.checks.cpplint
      && (config.mode === 'full' || !config.legacyChecks.cpplint))) return passSilent();

  const root = repoRoot(cwd);
  if (!root) return passSilent();

  let files;
  try {
    files = stagedCppFiles(root);
  } catch (error) {
    return denyTool(`提交被阻止：无法枚举 Git 暂存区，未执行完整 cpplint 检查。${error && error.message ? ` ${error.message}` : ''}`);
  }
  const fileChecks = new Map(files.map((file) => [file,
    config.mode === 'full' || isNew(file, root) !== false ? config.checks : config.legacyChecks]));
  files = files.filter((file) => fileChecks.get(file).cpplint);
  if (files.length === 0) return passSilent();

  const allViolations = [];
  const deadline = Date.now() + PRE_COMMIT_DEADLINE_MS;
  let snapshot;
  let cleanupError = null;
  try {
    snapshot = createStagedSnapshot(root, files);
    for (const stagedFile of snapshot.files) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 1000) {
        allViolations.push({
          file: stagedFile.relativePath,
          line: 0,
          category: 'runtime/timeout',
          message: 'pre-commit cpplint 总耗时超限，剩余文件未检查',
        });
        break;
      }
      try {
        const effectiveChecks = fileChecks.get(path.resolve(root, stagedFile.relativePath));
        const suppressCopyright = !(config.copyrightInfo && config.copyrightInfo.company)
          || !effectiveChecks.copyright;
        const v = runCpplint(stagedFile.filePath, {
          root: snapshot.root,
          suppressCopyright,
          timeoutMs: Math.min(15000, remainingMs),
        });
        for (const item of v) allViolations.push({ ...item, file: stagedFile.relativePath });
        if (v.some((item) => item.category === 'runtime/timeout')) break;
      } catch (e) {
        allViolations.push({ file: stagedFile.relativePath, line: 0,
          category: 'runtime/cpplint',
          message: `检查异常，未完成验证：${e && e.message ? e.message : e}` });
      }
    }
  } catch (e) {
    return denyTool(`提交被阻止：无法创建 Git index 快照，未执行 cpplint 检查。${e && e.message ? ` ${e.message}` : ''}`);
  } finally {
    if (snapshot) {
      try { snapshot.cleanup(); } catch (error) { cleanupError = error; }
    }
  }

  if (cleanupError) {
    return denyTool(`提交被阻止：无法清理 Git index 临时快照。${cleanupError.message ? ` ${cleanupError.message}` : ''}`);
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
    try { diag(`pre_commit 检查异常: ${e && e.message ? e.message : e}`); } catch (_) {}
    denyTool('提交前 C++ 检查异常，未完成验证；修复检查环境后重试。');
  });
}

module.exports = {
  commitCwd,
  gitSubcommand,
  isGitCommit,
  splitCommandSegments,
  stagedCppFiles,
  tokenizeCommand,
};
