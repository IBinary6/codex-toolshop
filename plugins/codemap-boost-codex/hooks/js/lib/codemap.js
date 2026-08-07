'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { crgRuntimePaths, probeCrgRuntime } = require('./bootstrap');

const {
  codexHome,
  ensureDir,
  isGitRepo,
  markerPath,
  repoRoot,
  spawnDetached,
  writeMarker,
} = require('./runtime');

const ENABLED_MARKER = '.codemap-boost-enabled';
const BOOTSTRAP_FAILED_MARKER = '.codemap-bootstrap-failed';
const LOCK_BOOT_MS = 5000;
const LOCK_STALE_MS = 4 * 60 * 60 * 1000;
const BOOTSTRAP_LOCK_STALE_MS = 30 * 60 * 1000;
const REFRESH_WAIT_MS = 10 * 60 * 1000;
const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx',
  '.cs', '.go', '.java', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.kt', '.kts', '.php', '.py', '.rb', '.rs', '.scala', '.swift', '.vue', '.svelte',
]);
const BLOCK_START = '<!-- codemap-boost-codex:start -->';
const BLOCK_END = '<!-- codemap-boost-codex:end -->';
const AGENTS_BLOCK = `${BLOCK_START}
## CodeMap Boost

本机已启用 CodeMap Boost。涉及代码结构、符号、调用关系、引用关系、影响面或代码审查上下文时，优先使用 code-review-graph MCP 工具；图刷新由 CodeMap Boost hooks 统一负责：

- SessionStart、结构类 UserPromptSubmit 和源码修改后的 PostToolUse 会同步维护图谱；每次图谱 MCP 读取前仍有 PreToolUse barrier 兜底，并把当前 Git 根目录注入 CRG 的 repo_root。
- 不要为了“先刷新”从主代理或子代理重复调用 \`mcp__code_review_graph__build_or_update_graph_tool\`。仅在 hook 明确报告刷新失败、用户要求强制重建或执行 setup/诊断时显式调用。
- 调度插件只负责选择合适的搜索或执行代理；CodeMap Boost 负责图刷新和检索规则。子代理启动时只注入规则，不重复 build/update。
- 如果当前任务的工具列表中不存在 \`mcp__code_review_graph__\`，必须明确报告该任务未加载 MCP，并使用合适的降级检索；不得声称已经查询图谱。
- 任务已经明确涉及影响面、代码审查、调用链、引用关系或跨模块定位时，直接调用对应的 \`semantic_search_nodes_tool\`、\`query_graph_tool\`、\`get_impact_radius_tool\` 或 review-context 工具。
- 任务不明确或需要快速路由时，最多调用一次 \`mcp__code_review_graph__get_minimal_context_tool\` 获取概览；不要反复调用 minimal 试探。
- 如果概览信息不足（缺少有效实体、文件、调用关系或下一步工具），立即升级到更完整的工具或使用 \`detail_level="standard"\`，不要再次调用 minimal。
- 符号、函数、类、调用链、引用关系优先用 \`semantic_search_nodes_tool\`、\`query_graph_tool\`、\`get_impact_radius_tool\`。
- 支持 \`detail_level\` 的工具默认使用低成本级别；若结果不足立即升级到 \`standard\`，不要重复低信息调用。
- 修改代码后，如果还要继续查询代码图或进行代码审查，必须先等待同步刷新完成；仅在没有未跟踪源文件时再调用 \`build_or_update_graph_tool\`。
- \`rg\`、\`grep\`、\`Select-String\` 只用于纯文本、注释或字符串搜索。

${BLOCK_END}
`;

function agentsPath(home = codexHome()) {
  return path.join(home, 'AGENTS.md');
}

function ensureAgentsBlock(home = codexHome()) {
  const target = agentsPath(home);
  let existing = '';
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') return false;
  }
  let next = '';
  if (existing.includes(BLOCK_START) && existing.includes(BLOCK_END)) {
    const start = existing.indexOf(BLOCK_START);
    const end = existing.indexOf(BLOCK_END, start) + BLOCK_END.length;
    next = existing.slice(0, start).replace(/\s+$/, '')
      + '\n\n' + AGENTS_BLOCK.trimEnd()
      + existing.slice(end);
  } else {
    next = existing.replace(/\s+$/, '');
    next += (next ? '\n\n' : '') + AGENTS_BLOCK.trimEnd() + '\n';
  }
  if (next === existing) return true;
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, next, 'utf8');
  return true;
}

function ensureGitignore(cwd) {
  const root = repoRoot(cwd);
  if (!root) return false;
  const target = path.join(root, '.gitignore');
  let content = '';
  try {
    content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  } catch (_) {
    return false;
  }
  const entries = ['.code-review-graph/', 'graphify-out/'];
  const missing = entries.filter((entry) => !content.split(/\r?\n/).includes(entry));
  if (missing.length === 0) return true;
  let append = content && !content.endsWith('\n') ? '\n' : '';
  append += '# CodeMap generated output\n';
  append += missing.join('\n') + '\n';
  fs.appendFileSync(target, append, 'utf8');
  return true;
}

function ensureGitInfoExclude(cwd) {
  const root = repoRoot(cwd);
  if (!root) return false;
  let target = '';
  try {
    const result = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: process.platform === 'win32',
      timeout: 5000,
    });
    if (!result.error && result.status === 0) target = result.stdout.trim();
  } catch (_) {}
  if (!target) return false;
  if (!path.isAbsolute(target)) target = path.resolve(root, target);
  let content = '';
  try {
    content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  } catch (_) {
    return false;
  }
  const entries = ['.code-review-graph/', 'graphify-out/'];
  const missing = entries.filter((entry) => !content.split(/\r?\n/).includes(entry));
  if (missing.length === 0) return true;
  let append = content && !content.endsWith('\n') ? '\n' : '';
  append += '# CodeMap generated output\n';
  append += missing.join('\n') + '\n';
  try {
    ensureDir(path.dirname(target));
    fs.appendFileSync(target, append, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function crgCommand(options = {}) {
  if (typeof options.crgCommand === 'function') return options.crgCommand();
  if (typeof options.crgCommand === 'string' && options.crgCommand) return options.crgCommand;
  return crgRuntimePaths(options).command;
}

function canUseCrg(options = {}) {
  if (process.env.CODEMAP_BOOST_ASSUME_CRG === '1') return true;
  return probeCrgRuntime(options);
}

function isCodeMapEnabled() {
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') return false;
  return canUseCrg();
}

function enableCodeMap() {
  writeMarker(ENABLED_MARKER);
  return true;
}

function lockName(prefix, cwd) {
  const key = crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return `${prefix}-${key}.lock`;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function isLockActive(file, staleMs = LOCK_STALE_MS) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10) || 0;
    const stat = fs.statSync(file);
    const age = Date.now() - stat.mtimeMs;
    if (age <= LOCK_BOOT_MS) return true;
    if (age <= staleMs && isPidAlive(pid)) return true;
    fs.unlinkSync(file);
  } catch (_) {}
  return false;
}

function tryWriteLock(file) {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch (_) {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireRefreshLock(lockFile, waitMs = REFRESH_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    if (!isLockActive(lockFile) && tryWriteLock(lockFile)) return true;
    sleepSync(50);
  }
  return false;
}

function gitResult(cwd, args, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  try {
    return spawn('git', args, {
      cwd,
      env: options.env || process.env,
      encoding: 'utf8',
      stdio: options.stdio || ['ignore', 'pipe', 'ignore'],
      windowsHide: process.platform === 'win32',
      timeout: options.timeout || 30000,
    });
  } catch (error) {
    return { status: null, error, stdout: '', stderr: '' };
  }
}

function untrackedSourceFiles(root) {
  const result = gitResult(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (result.error || result.status !== 0) return [];
  return String(result.stdout || '')
    .split('\0')
    .filter(Boolean)
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function withTemporaryGitIndex(root, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-git-index-'));
  const indexFile = path.join(tempDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    const head = gitResult(root, ['rev-parse', '--verify', 'HEAD']);
    const readTreeArgs = !head.error && head.status === 0 ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'];
    const readTree = gitResult(root, readTreeArgs, { env });
    if (readTree.error || readTree.status !== 0) return false;
    const add = gitResult(root, ['add', '-A', '--', '.'], { env, timeout: 120000 });
    if (add.error || add.status !== 0) return false;
    return callback(env);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function runCrgDefault(args, options = {}) {
  const command = crgCommand(options);
  const common = {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: options.stdio || 'ignore',
    windowsHide: process.platform === 'win32',
    timeout: options.timeout || REFRESH_WAIT_MS,
  };
  return spawnSync(command, args, common);
}

function refreshCrgSync(cwd, options = {}) {
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') return false;
  const canUse = options.canUseCrg || canUseCrg;
  if (!canUse()) return false;
  const root = repoRoot(cwd);
  if (!root) return false;
  ensureGitInfoExclude(root);

  const lockFile = path.join(os.tmpdir(), lockName('codemap-crg-refresh', root));
  if (!acquireRefreshLock(lockFile, options.waitMs || REFRESH_WAIT_MS)) return false;
  try {
    const hasGraph = fs.existsSync(path.join(root, '.code-review-graph'));
    const hasUntrackedSource = untrackedSourceFiles(root).length > 0;
    const args = [hasGraph && !hasUntrackedSource ? 'update' : 'build', '--repo', root];
    const runCrg = options.runCrg || runCrgDefault;
    const invoke = (env) => {
      const result = runCrg(args, {
        cwd: root,
        env,
        stdio: 'ignore',
        timeout: options.timeout || REFRESH_WAIT_MS,
      });
      return !!result && !result.error && result.status === 0;
    };
    return hasUntrackedSource ? withTemporaryGitIndex(root, invoke) : invoke(process.env);
  } finally {
    try { fs.unlinkSync(lockFile); } catch (_) {}
  }
}

function listLinkedWorktrees(cwd) {
  const root = repoRoot(cwd);
  if (!root) return [];
  const result = gitResult(root, ['worktree', 'list', '--porcelain']);
  if (result.error || result.status !== 0) return [root];
  return String(result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => {
      const worktree = path.resolve(line.slice('worktree '.length).trim());
      try {
        const realpath = fs.realpathSync.native || fs.realpathSync;
        return realpath(worktree);
      } catch (_) {
        return worktree;
      }
    })
    .filter((worktree, index, all) => fs.existsSync(worktree) && all.indexOf(worktree) === index);
}

function refreshLinkedWorktreesSync(cwd, options = {}) {
  const worktrees = listLinkedWorktrees(cwd);
  if (worktrees.length === 0) return false;
  let ok = true;
  for (const worktree of worktrees) {
    if (!refreshCrgSync(worktree, options)) ok = false;
  }
  return ok;
}

function startCrgBuild(cwd, options = {}) {
  if (process.env.CODEMAP_BOOST_DISABLE_BACKGROUND === '1') return false;
  const enabled = options.isCodeMapEnabled || isCodeMapEnabled;
  if (!enabled() || !isGitRepo(cwd)) return false;
  const root = repoRoot(cwd);
  if (!root) return false;
  const graphDir = path.join(root, '.code-review-graph');
  if (fs.existsSync(graphDir)) return false;
  const lockFile = path.join(os.tmpdir(), lockName('codemap-crg-refresh', root));
  if (isLockActive(lockFile)) return false;
  if (!tryWriteLock(lockFile)) return false;
  const command = crgCommand(options);
  const code = `
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    try {
      try { fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid)); } catch (_) {}
      spawnSync(${JSON.stringify(command)}, ['build', '--repo', ${JSON.stringify(root)}], {
        cwd: ${JSON.stringify(root)},
        stdio: 'ignore',
        windowsHide: true
      });
    } finally {
      try { fs.unlinkSync(${JSON.stringify(lockFile)}); } catch (_) {}
    }
  `;
  const launch = options.spawnDetached || spawnDetached;
  const child = launch(process.execPath, ['-e', code], { cwd: root });
  if (!child) {
    try { fs.unlinkSync(lockFile); } catch (_) {}
    return false;
  }
  return true;
}

function writeBootstrapDiagnostic(diagnostic) {
  try {
    const target = markerPath(BOOTSTRAP_FAILED_MARKER);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, `${diagnostic}\n`, 'utf8');
  } catch (_) {}
}

/**
 * 在 SessionStart 中启动一次后台环境自愈，并用锁避免重复安装。
 * @example startAutoBootstrap(process.cwd())
 */
function startAutoBootstrap(cwd, options = {}) {
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') return false;
  if (process.env.CODEMAP_BOOST_DISABLE_BOOTSTRAP === '1') return false;
  const root = repoRoot(cwd);
  if (!root) return false;
  const probe = options.canUseCrg || canUseCrg;
  const hasCrg = probe();
  if (hasCrg) {
    enableCodeMap();
    return false;
  }
  const lockFile = path.join(os.tmpdir(), lockName('codemap-bootstrap', root));
  // 已有进程持锁或刚刚抢到锁时，都向当前任务报告“正在 bootstrap”，避免静默跳过。
  if (isLockActive(lockFile, BOOTSTRAP_LOCK_STALE_MS)) return true;
  if (!tryWriteLock(lockFile)) {
    if (isLockActive(lockFile, BOOTSTRAP_LOCK_STALE_MS)) return true;
    writeBootstrapDiagnostic('CodeMap Boost 无法创建后台安装锁。请检查插件数据目录权限，运行 setup 后新开任务。');
    return false;
  }
  const code = `
    const fs = require('fs');
    const { markerPath } = require(${JSON.stringify(path.join(__dirname, 'runtime.js'))});
    const { ensureCrg } = require(${JSON.stringify(path.join(__dirname, 'bootstrap.js'))});
    const codemap = require(${JSON.stringify(__filename)});
    try {
      try { fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid)); } catch (_) {}
      if (ensureCrg()) {
        const migration = codemap.removeLegacyCrgMcp({ cwd: ${JSON.stringify(root)} });
        if (migration.ok) {
          codemap.enableCodeMap();
          try { fs.rmSync(markerPath(${JSON.stringify(BOOTSTRAP_FAILED_MARKER)}), { force: true }); } catch (_) {}
          codemap.cleanLegacyCrgHooks();
          codemap.cleanLegacyCrgGitHook(${JSON.stringify(root)});
          codemap.ensureAgentsBlock();
          codemap.ensureGitInfoExclude(${JSON.stringify(root)});
          codemap.startCrgBuild(${JSON.stringify(root)});
        } else {
          try { fs.writeFileSync(markerPath(${JSON.stringify(BOOTSTRAP_FAILED_MARKER)}), migration.diagnostic || '1'); } catch (_) {}
        }
      } else {
        const diagnostic = codemap.readBootstrapFailure();
        try { fs.writeFileSync(markerPath(${JSON.stringify(BOOTSTRAP_FAILED_MARKER)}), diagnostic || '1'); } catch (_) {}
      }
    } finally {
      try { fs.unlinkSync(${JSON.stringify(lockFile)}); } catch (_) {}
    }
  `;
  const launch = options.spawnDetached || spawnDetached;
  const child = launch(process.execPath, ['-e', code], { cwd: root });
  if (!child) {
    try { fs.unlinkSync(lockFile); } catch (_) {}
    writeBootstrapDiagnostic('CodeMap Boost 无法启动后台隔离运行环境安装。请在目标仓库运行 setup 后新开任务。');
    return false;
  }
  return true;
}

function startCrgUpdate(cwd, options = {}) {
  if (process.env.CODEMAP_BOOST_DISABLE_BACKGROUND === '1') return false;
  const enabled = options.isCodeMapEnabled || isCodeMapEnabled;
  if (!enabled() || !isGitRepo(cwd)) return false;
  const root = repoRoot(cwd);
  if (!root) return false;
  if (!fs.existsSync(path.join(root, '.code-review-graph'))) return false;
  const lockFile = path.join(os.tmpdir(), lockName('codemap-crg-refresh', root));
  if (isLockActive(lockFile)) return false;
  if (!tryWriteLock(lockFile)) return false;
  const command = crgCommand(options);
  const code = `
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    try {
      try { fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid)); } catch (_) {}
      spawnSync(${JSON.stringify(command)}, ['update', '--repo', ${JSON.stringify(root)}], {
        cwd: ${JSON.stringify(root)},
        stdio: 'ignore',
        windowsHide: true
      });
    } finally {
      try { fs.unlinkSync(${JSON.stringify(lockFile)}); } catch (_) {}
    }
  `;
  const launch = options.spawnDetached || spawnDetached;
  const child = launch(process.execPath, ['-e', code], { cwd: root });
  if (!child) {
    try { fs.unlinkSync(lockFile); } catch (_) {}
    return false;
  }
  return true;
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/[\u001b\u005d].*?(?:\u0007|\u001b\\)/g, '');
}

function parseMcpJson(value) {
  if (value && typeof value === 'object') return value;
  const text = stripAnsi(value);
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    let depth = 0;
    let quote = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quote = false;
        continue;
      }
      if (char === '"') {
        quote = true;
        continue;
      }
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') depth -= 1;
      if (depth !== 0) continue;
      try { return JSON.parse(text.slice(start, index + 1)); } catch (_) { break; }
    }
  }
  return null;
}

function mcpTransport(config) {
  if (!config || typeof config !== 'object') return {};
  const transport = config.transport;
  if (transport && typeof transport === 'object') return transport;
  return config;
}

/**
 * 判断同名全局 MCP 是否为所有权不明确的旧式 uvx 启动方式。
 * @example isLegacyUvxCrgMcpConfig({ command: 'uvx', args: ['code-review-graph', 'serve'] })
 */
function isLegacyUvxCrgMcpConfig(config) {
  if (!config || typeof config !== 'object') return false;
  const transport = mcpTransport(config);
  const type = typeof config.transport === 'string'
    ? config.transport
    : (transport.type || config.type || config.transport_type || 'stdio');
  if (String(type).toLowerCase() !== 'stdio') return false;
  const command = String(transport.command || config.command || '');
  const args = transport.args || config.args;
  if (!Array.isArray(args)) return false;
  const normalizedArgs = JSON.stringify(args);
  return path.basename(command).toLowerCase() === 'uvx'
    && normalizedArgs === JSON.stringify(['code-review-graph', 'serve']);
}

/**
 * 判断同名全局 MCP 是否能由路径证明属于旧版插件私有运行时。
 * @example isPluginManagedLegacyCrgMcpConfig({ command: '/home/me/.codex/plugins/data/codemap-boost-codex-shop/crg-runtime/bin/code-review-graph', args: ['serve'] })
 */
function isPluginManagedLegacyCrgMcpConfig(config) {
  if (!config || typeof config !== 'object') return false;
  const transport = mcpTransport(config);
  const type = typeof config.transport === 'string'
    ? config.transport
    : (transport.type || config.type || config.transport_type || 'stdio');
  if (String(type).toLowerCase() !== 'stdio') return false;
  const command = String(transport.command || config.command || '').replace(/\\/g, '/');
  const args = transport.args || config.args;
  if (!Array.isArray(args)) return false;
  return /\/plugins\/data\/codemap-boost-codex(?:-[^/]+)?\/crg-runtime\/(?:Scripts|bin)\/code-review-graph(?:\.exe)?$/i.test(command)
    && JSON.stringify(args) === JSON.stringify(['serve']);
}

/**
 * 判断当前 MCP 配置是否来自插件自带的跨平台启动器。
 * @example isNativeCrgMcpConfig({ command: 'node', args: ['scripts/mcp-server.cjs'], cwd: '.', startup_timeout_sec: 100 }, { allowRelativeCwd: true })
 */
function isNativeCrgMcpConfig(config, options = {}) {
  if (!config || typeof config !== 'object') return false;
  if (config.enabled === false && !options.allowDisabled) return false;
  const transport = mcpTransport(config);
  const type = typeof config.transport === 'string'
    ? config.transport
    : (transport.type || config.type || config.transport_type || 'stdio');
  const command = String(transport.command || config.command || '');
  const args = transport.args || config.args;
  const cwd = String(transport.cwd ?? config.cwd ?? '');
  const timeout = Number(config.startup_timeout_sec ?? config.startupTimeoutSec);
  let cwdOk = false;
  if (options.allowRelativeCwd) cwdOk = cwd === '.';
  else if (options.expectedCwd && cwd) {
    const actual = path.resolve(cwd);
    const expected = path.resolve(options.expectedCwd);
    cwdOk = process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  }
  return String(type).toLowerCase() === 'stdio'
    && ['node', 'node.exe'].includes(path.basename(command).toLowerCase())
    && Array.isArray(args)
    && JSON.stringify(args) === JSON.stringify(['scripts/mcp-server.cjs'])
    && cwdOk
    && Number.isFinite(timeout)
    && timeout === 100;
}

function readBootstrapFailure() {
  for (const name of ['.crg-install-failed', BOOTSTRAP_FAILED_MARKER]) {
    try {
      const diagnostic = fs.readFileSync(markerPath(name), 'utf8').trim();
      if (diagnostic && diagnostic !== '1') return diagnostic;
    } catch (_) {}
  }
  return '';
}

/**
 * 运行已解析的 Codex CLI；Windows 批处理入口必须经 cmd.exe 启动。
 * @example runCodexCommand('codex', ['--version'])
 */
function runCodexCommand(command, args, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const env = options.env || process.env;
  const useCmdShim = process.platform === 'win32'
    && !options.spawnSync
    && /\.(?:cmd|bat)$/i.test(command);
  const executable = useCmdShim ? (env.ComSpec || process.env.ComSpec || 'cmd.exe') : command;
  const commandEnv = useCmdShim ? { ...env, CODEMAP_BOOST_CODEX_COMMAND: command } : env;
  if (useCmdShim) {
    args.forEach((arg, index) => {
      commandEnv[`CODEMAP_BOOST_CODEX_ARG_${index}`] = String(arg);
    });
  }
  const commandArgRefs = args.map((arg, index) => {
    const ref = `%CODEMAP_BOOST_CODEX_ARG_${index}%`;
    return /^[A-Za-z0-9_./:\\-]+$/.test(String(arg)) ? ref : `"${ref}"`;
  });
  const commandArgs = useCmdShim
    ? [
        '/d',
        '/v:off',
        '/s',
        '/c',
        `""%CODEMAP_BOOST_CODEX_COMMAND%" ${commandArgRefs.join(' ')}"`,
      ]
    : args;
  try {
    return spawn(executable, commandArgs, {
      cwd: options.cwd || process.cwd(),
      env: commandEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout || 30000,
      windowsHide: process.platform === 'win32',
      windowsVerbatimArguments: useCmdShim,
    });
  } catch (error) {
    return { status: null, error, stdout: '', stderr: '' };
  }
}

/**
 * 从 PATH 中逐个探测 Codex CLI，跳过存在但无法执行的桌面应用入口。
 * @example resolveCodexCommand({ cwd: process.cwd() })
 */
function resolveCodexCommand(options = {}) {
  const env = options.env || process.env;
  const explicit = String(env.CODEMAP_BOOST_CODEX_CLI || '').trim();
  const candidates = [];
  if (explicit) {
    candidates.push(explicit);
  } else {
    const suffixes = process.platform === 'win32'
      ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
    const names = process.platform === 'win32'
      ? [...suffixes.map((suffix) => `codex${suffix.toLowerCase()}`), 'codex']
      : ['codex'];
    for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const name of names) {
        const candidate = path.resolve(directory.replace(/^"|"$/g, ''), name);
        try {
          if (fs.statSync(candidate).isFile()) candidates.push(candidate);
        } catch (_) {}
      }
    }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    const probe = runCodexCommand(candidate, ['--version'], { ...options, env, timeout: 10000 });
    if (probe && !probe.error && probe.status === 0) return candidate;
  }
  return null;
}

/**
 * 通过已验证的 CLI 执行 Codex MCP 子命令；测试可注入 spawnSync。
 * @example runCodexMcp(['mcp', 'get', 'code-review-graph', '--json'])
 */
function runCodexMcp(args, options = {}) {
  const command = options.codexCommand
    || (options.spawnSync ? 'codex' : resolveCodexCommand(options));
  if (!command) {
    const error = new Error('Codex CLI is unavailable');
    error.code = 'ENOENT';
    return { status: null, error, stdout: '', stderr: '', available: false };
  }
  return runCodexCommand(command, args, options);
}

/**
 * 删除可由私有运行时路径证明归属插件的旧版全局注册。
 * @example removeLegacyCrgMcp({ cwd: process.cwd() })
 */
function removeLegacyCrgMcp(options = {}) {
  const codexCommand = options.codexCommand
    || (options.spawnSync ? 'codex' : resolveCodexCommand(options));
  if (!codexCommand) {
    return {
      ok: true,
      changed: false,
      skipped: true,
      diagnostic: '未找到可执行的独立 Codex CLI，无法检查旧版全局 MCP 覆盖；插件原生 MCP 启动本身不依赖 CLI。',
    };
  }
  const commandOptions = { ...options, codexCommand };
  const getResult = runCodexMcp(['mcp', 'get', 'code-review-graph', '--json'], commandOptions);
  const output = `${getResult && getResult.stdout ? getResult.stdout : ''}\n${getResult && getResult.stderr ? getResult.stderr : ''}`;
  const config = parseMcpJson(output);
  if (!isPluginManagedLegacyCrgMcpConfig(config)) return { ok: true, changed: false };
  const removeResult = runCodexMcp(['mcp', 'remove', 'code-review-graph'], commandOptions);
  if (removeResult && !removeResult.error && removeResult.status === 0) {
    return { ok: true, changed: true };
  }
  return {
    ok: false,
    changed: false,
    diagnostic: '无法移除旧版 code-review-graph 全局注册；它会遮蔽插件原生 MCP。请运行 setup 自动修复。',
  };
}

const CONTEXT = [
  'CodeMap Boost owns graph freshness: SessionStart, structural prompts, source-changing tools, and the graph MCP PreToolUse barrier synchronize the graph.',
  'If the current tool list does not expose mcp__code_review_graph__, report that the MCP tools are unavailable in this task and use an appropriate fallback; do not claim that a graph query ran.',
  'Do not start a duplicate build/update from the primary agent or a spawned agent unless a hook reports refresh failure, the user requests a forced rebuild, or you are troubleshooting setup.',
  'Routing integrations select the agent; CodeMap Boost owns graph refresh and retrieval policy. SubagentStart injects these rules without refreshing again.',
  'Use adaptive retrieval: when the task is clear, call the specialized tool directly (semantic_search_nodes_tool, query_graph_tool, get_impact_radius_tool, or the relevant review-context tool).',
  'When the task is unclear, get_minimal_context_tool may be called once as a routing overview; do not repeat minimal. If the result lacks a useful entity, file, relationship, or next tool, immediately upgrade to a fuller tool or detail_level="standard".',
  'Use the lowest-cost detail level that can answer the question, then upgrade immediately when needed. Use rg/grep only for literal text, comments, or strings.',
].join(' ');

function promptLooksStructural(text) {
  const value = String(text || '').toLowerCase();
  return /symbol|function|class|caller|callee|call graph|reference|impact|review context|codemap|code map|代码结构|符号|函数|类|调用|引用|影响面|代码审查/.test(value);
}

function bashLooksLikeCodeSearch(command) {
  const value = String(command || '');
  if (!/\b(rg|grep|findstr|Select-String)\b/i.test(value)) return false;
  return !/\.code-review-graph|graphify-out/.test(value);
}

function normalizeLegacyCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

function isLegacyCrgCommand(command) {
  const normalized = normalizeLegacyCommand(command);
  return normalized === 'code-review-graph status || true'
    || normalized === 'code-review-graph update --skip-flows || true'
    || normalized === 'cat >/dev/null || true; code-review-graph status || true'
    || normalized === 'cat >/dev/null || true; code-review-graph update --skip-flows || true';
}

function cleanLegacyCrgHooks(home = codexHome()) {
  const target = path.join(home, 'hooks.json');
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.hooks) return false;
  let changed = false;
  for (const eventName of Object.keys(parsed.hooks)) {
    if (!Array.isArray(parsed.hooks[eventName])) continue;
    const next = [];
    for (const group of parsed.hooks[eventName]) {
      if (!group || !Array.isArray(group.hooks)) {
        next.push(group);
        continue;
      }
      const hooks = group.hooks.filter((hook) => !isLegacyCrgCommand(hook && hook.command));
      if (hooks.length !== group.hooks.length) changed = true;
      if (hooks.length > 0) next.push({ ...group, hooks });
    }
    if (next.length !== parsed.hooks[eventName].length) {
      changed = true;
      if (next.length === 0) delete parsed.hooks[eventName];
      else parsed.hooks[eventName] = next;
    }
  }
  if (!changed) return false;
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return true;
}

function cleanLegacyCrgGitHook(cwd) {
  const root = repoRoot(cwd);
  if (!root) return false;
  const target = path.join(root, '.git', 'hooks', 'pre-commit');
  let content = '';
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return false;
  }
  if (!content.includes('Installed by code-review-graph')) return false;
  if (!content.includes('code-review-graph update')) return false;
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) =>
    !line.includes('Installed by code-review-graph')
    && normalizeLegacyCommand(line) !== 'code-review-graph update || true'
  );
  const meaningful = kept.filter((line) => {
    const trimmed = line.trim();
    return trimmed && trimmed !== '#!/bin/sh' && trimmed !== '#!/usr/bin/env sh';
  });
  try {
    if (meaningful.length === 0) {
      fs.unlinkSync(target);
    } else {
      fs.writeFileSync(target, `${kept.join('\n').replace(/\s+$/, '')}\n`, 'utf8');
    }
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  BLOCK_START,
  BLOCK_END,
  AGENTS_BLOCK,
  CONTEXT,
  ENABLED_MARKER,
  BOOTSTRAP_FAILED_MARKER,
  agentsPath,
  ensureAgentsBlock,
  ensureGitignore,
  ensureGitInfoExclude,
  crgCommand,
  canUseCrg,
  isCodeMapEnabled,
  enableCodeMap,
  startAutoBootstrap,
  startCrgBuild,
  startCrgUpdate,
  refreshCrgSync,
  listLinkedWorktrees,
  refreshLinkedWorktreesSync,
  parseMcpJson,
  isLegacyUvxCrgMcpConfig,
  isPluginManagedLegacyCrgMcpConfig,
  isNativeCrgMcpConfig,
  resolveCodexCommand,
  runCodexMcp,
  removeLegacyCrgMcp,
  readBootstrapFailure,
  cleanLegacyCrgHooks,
  cleanLegacyCrgGitHook,
  promptLooksStructural,
  bashLooksLikeCodeSearch,
};
