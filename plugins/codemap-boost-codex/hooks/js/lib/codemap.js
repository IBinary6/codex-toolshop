'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  codexHome,
  commandExists,
  ensureDir,
  isGitRepo,
  markerExists,
  repoRoot,
  spawnDetached,
  writeMarker,
} = require('./runtime');

const ENABLED_MARKER = '.codemap-boost-enabled';
const LOCK_BOOT_MS = 5000;
const LOCK_STALE_MS = 4 * 60 * 60 * 1000;
const UPDATE_THROTTLE_MS = 30 * 1000;
const BLOCK_START = '<!-- codemap-boost-codex:start -->';
const BLOCK_END = '<!-- codemap-boost-codex:end -->';
const AGENTS_BLOCK = `${BLOCK_START}
## CodeMap Boost

本机已启用 CodeMap Boost。涉及代码结构、符号、调用关系、引用关系、影响面或代码审查上下文时，优先使用 code-review-graph MCP 工具：

- 先调用 \`mcp__code_review_graph__get_minimal_context_tool\` 获取低 token 概览。
- 符号、函数、类、调用链、引用关系优先用 \`semantic_search_nodes_tool\`、\`query_graph_tool\`、\`get_impact_radius_tool\`。
- 支持 \`detail_level\` 的工具默认传 \`minimal\`，只有信息不足时再升级。
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

function removeAgentsBlock(home = codexHome()) {
  const target = agentsPath(home);
  let existing = '';
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return false;
  }
  if (!existing.includes(BLOCK_START) || !existing.includes(BLOCK_END)) return false;
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END, start) + BLOCK_END.length;
  const next = (existing.slice(0, start) + existing.slice(end)).replace(/\s+$/, '');
  fs.writeFileSync(target, next ? `${next}\n` : '', 'utf8');
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

function canUseCrg() {
  return commandExists('code-review-graph');
}

function isCodeMapEnabled() {
  if (process.env.CODEMAP_BOOST_DISABLE_GRAPH === '1') return false;
  if (process.env.CODEMAP_BOOST_ENABLE_GRAPH === '1') return true;
  return markerExists(ENABLED_MARKER);
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

function isLockActive(file) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10) || 0;
    const stat = fs.statSync(file);
    const age = Date.now() - stat.mtimeMs;
    if (age <= LOCK_BOOT_MS) return true;
    if (age <= LOCK_STALE_MS && isPidAlive(pid)) return true;
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

function recentlyTouched(file, maxAgeMs) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < maxAgeMs;
  } catch (_) {
    return false;
  }
}

function touchFile(file) {
  try {
    fs.writeFileSync(file, String(Date.now()));
    return true;
  } catch (_) {
    return false;
  }
}

function startCrgBuild(cwd) {
  if (process.env.CODEMAP_BOOST_DISABLE_BACKGROUND === '1') return false;
  if (!isCodeMapEnabled() || !isGitRepo(cwd) || !canUseCrg()) return false;
  const root = repoRoot(cwd);
  if (!root) return false;
  const graphDir = path.join(root, '.code-review-graph');
  if (fs.existsSync(graphDir)) return false;
  const lockFile = path.join(os.tmpdir(), lockName('codemap-crg-build', root));
  if (isLockActive(lockFile)) return false;
  if (!tryWriteLock(lockFile)) return false;
  const code = `
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    try {
      try { fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid)); } catch (_) {}
      spawnSync('code-review-graph', ['build', '--repo', ${JSON.stringify(root)}], {
        cwd: ${JSON.stringify(root)},
        stdio: 'ignore',
        windowsHide: true
      });
    } finally {
      try { fs.unlinkSync(${JSON.stringify(lockFile)}); } catch (_) {}
    }
  `;
  const child = spawnDetached(process.execPath, ['-e', code], { cwd: root });
  if (!child) {
    try { fs.unlinkSync(lockFile); } catch (_) {}
    return false;
  }
  return true;
}

function startCrgUpdate(cwd) {
  if (process.env.CODEMAP_BOOST_DISABLE_BACKGROUND === '1') return false;
  if (!isCodeMapEnabled() || !isGitRepo(cwd) || !canUseCrg()) return false;
  const root = repoRoot(cwd);
  if (!root) return false;
  if (!fs.existsSync(path.join(root, '.code-review-graph'))) return false;
  const stampFile = path.join(os.tmpdir(), lockName('codemap-crg-update-stamp', root));
  if (recentlyTouched(stampFile, UPDATE_THROTTLE_MS)) return false;
  const lockFile = path.join(os.tmpdir(), lockName('codemap-crg-update', root));
  if (isLockActive(lockFile)) return false;
  if (!tryWriteLock(lockFile)) return false;
  touchFile(stampFile);
  const code = `
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    try {
      try { fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid)); } catch (_) {}
      spawnSync('code-review-graph', ['update', '--repo', ${JSON.stringify(root)}], {
        cwd: ${JSON.stringify(root)},
        stdio: 'ignore',
        windowsHide: true
      });
    } finally {
      try { fs.unlinkSync(${JSON.stringify(lockFile)}); } catch (_) {}
    }
  `;
  const child = spawnDetached(process.execPath, ['-e', code], { cwd: root });
  if (!child) {
    try { fs.unlinkSync(lockFile); } catch (_) {}
    return false;
  }
  return true;
}

function registerCrgMcp(options = {}) {
  const canUse = options.canUseCrg || canUseCrg;
  const spawn = options.spawnSync || spawnSync;
  if (!canUse()) return false;
  if (markerExists('.crg-codex-register-failed')) return false;
  try {
    const result = spawn('code-review-graph', [
      'install',
      '--platform',
      'codex',
      '--no-hooks',
      '--no-instructions',
      '--no-skills',
      '--yes',
    ], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
      timeout: 30000,
      windowsHide: process.platform === 'win32',
    });
    if (!result.error && result.status === 0) return true;
  } catch (_) {}
  writeMarker('.crg-codex-register-failed');
  return false;
}

const CONTEXT = [
  'CodeMap Boost: for symbol, function, class, call graph, reference, impact, or review-context work, prefer code-review-graph MCP tools before text search.',
  'Start with mcp__code_review_graph__get_minimal_context_tool, then use semantic_search_nodes_tool, query_graph_tool, or get_impact_radius_tool as needed.',
  'Use detail_level="minimal" first. Use rg/grep only for literal text, comments, or strings.',
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

function isLegacyCrgHook(group) {
  const text = JSON.stringify(group);
  return text.includes('code-review-graph status')
    || text.includes('code-review-graph update --skip-flows');
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
    const next = parsed.hooks[eventName].filter((group) => !isLegacyCrgHook(group));
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
  try {
    fs.unlinkSync(target);
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
  agentsPath,
  ensureAgentsBlock,
  removeAgentsBlock,
  ensureGitignore,
  canUseCrg,
  isCodeMapEnabled,
  enableCodeMap,
  startCrgBuild,
  startCrgUpdate,
  registerCrgMcp,
  cleanLegacyCrgHooks,
  cleanLegacyCrgGitHook,
  promptLooksStructural,
  bashLooksLikeCodeSearch,
};
