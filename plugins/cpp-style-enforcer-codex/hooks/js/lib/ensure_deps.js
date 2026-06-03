'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const isWindows = process.platform === 'win32';
// 插件根：hooks/js/lib → hooks/js → hooks → 插件根。
// 优先用 hook 运行时注入的 CLAUDE_PLUGIN_ROOT；缺失（如直接 node 跑测试）回退到相对 __dirname。
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..', '..', '..');

/**
 * 持久数据目录（~/.claude/plugins/data/{id}/）。由 hook 运行时注入 CLAUDE_PLUGIN_DATA。
 * 缺失（直接 node 跑测试 / 老版本宿主）→ null，调用方据此降级。
 */
function pluginDataDir() {
  const d = process.env.CLAUDE_PLUGIN_DATA;
  return d ? d : null;
}

/**
 * 标记文件绝对路径（用于“安装已失败、勿重试”）。
 * 安装目标在 PLUGIN_DATA，失败标记也应随之落 PLUGIN_DATA（持久、可写）；
 * PLUGIN_DATA 缺失时回退插件根，保持旧行为不崩。
 */
function markerPath(name) {
  const dataDir = pluginDataDir();
  return path.join(dataDir || PLUGIN_ROOT, name);
}

/** 安全检测：标记文件是否存在 */
function markerExists(p) {
  try { return !!p && fs.existsSync(p); } catch (_) { return false; }
}

/** 安全写标记，失败静默 */
function writeMarker(p) {
  try { if (p) fs.writeFileSync(p, '1'); } catch (_) {}
}

/**
 * 安装 iconv-lite 到持久数据目录 PLUGIN_DATA（而非插件根）。
 * 原因：marketplace bundle 通道会剥离打包的 node_modules，且插件目录每次更新整体替换、
 * 只读场景不可写；PLUGIN_DATA 持久且可写。PLUGIN_DATA 缺失 → 跳过安装返回 false（别崩）。
 * 用 `npm install <pkg> --prefix <dataDir>`，依赖名硬编码与 package.json 一致。
 */
function npmInstall() {
  const dataDir = pluginDataDir();
  if (!dataDir) return false; // 无持久目录 → 不安装（降级，不崩）
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (_) {}
  try {
    const r = spawnSync(
      isWindows ? 'npm.cmd' : 'npm',
      ['install', 'iconv-lite@^0.6.3', '--no-audit', '--no-fund', '--no-save', '--prefix', dataDir],
      { cwd: dataDir, stdio: 'ignore', timeout: 60000, windowsHide: isWindows }
    );
    return !r.error && r.status === 0;
  } catch (_) {
    return false;
  }
}

/** 默认：pip 安装 clang-format（靠 python，跨平台最稳） */
function pipInstallClangFormat() {
  for (const py of ['python', 'python3']) {
    try {
      const r = spawnSync(
        py,
        ['-m', 'pip', 'install', '--disable-pip-version-check', 'clang-format'],
        { stdio: 'ignore', timeout: 120000, windowsHide: isWindows }
      );
      if (!r.error && r.status === 0) return true;
    } catch (_) {}
  }
  return false;
}

/**
 * 默认探测：以 `<cmd> [...args] --version` 试跑一个调用描述是否可用。
 * @param {{cmd:string, args:string[]}} desc
 * @returns {boolean}
 */
function probeClangFormat(desc) {
  try {
    const r = spawnSync(desc.cmd, [...desc.args, '--version'], { stdio: 'ignore', timeout: 10000, windowsHide: isWindows });
    return !r.error && r.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * 默认：拿 python(/python3) 的 Scripts 目录里 clang-format 可执行的绝对路径候选。
 * pip 安装的入口脚本常落在此目录，可能不在 PATH。失败静默返回 []。
 * @returns {Array<{cmd:string, args:string[]}>}
 */
function scriptsDirCandidates() {
  const out = [];
  for (const py of ['python', 'python3']) {
    let dir = null;
    try {
      const r = spawnSync(py, ['-c', "import sysconfig; print(sysconfig.get_path('scripts'))"],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, windowsHide: isWindows });
      if (!r.error && r.status === 0 && r.stdout) dir = String(r.stdout).trim();
    } catch (_) {}
    if (!dir) continue;
    for (const exe of isWindows ? ['clang-format.exe', 'clang-format'] : ['clang-format']) {
      const p = path.join(dir, exe);
      try { if (fs.existsSync(p)) out.push({ cmd: p, args: [] }); } catch (_) {}
    }
  }
  return out;
}

/**
 * 默认：按顺序找出可用的 clang-format 调用方式，返回调用描述 {cmd, args}，找不到返回 null。
 * 顺序：1) PATH 的 clang-format  2) pip 包模块入口 python -m clang_format(python/python3)
 *      3) python Scripts 目录下的 clang-format 可执行。
 *
 * @param {object} [opts]
 * @param {function({cmd:string,args:string[]}):boolean} [opts.probe] 注入探测函数（测试用）
 * @param {function():Array<{cmd:string,args:string[]}>} [opts.scriptsDirs] 注入 Scripts 候选生成（测试用）
 * @returns {{cmd:string, args:string[]}|null}
 */
function detectClangFormat(opts) {
  const o = opts || {};
  const probe = o.probe || probeClangFormat;
  const scriptsDirs = o.scriptsDirs || scriptsDirCandidates;

  const candidates = [
    { cmd: 'clang-format', args: [] },
    { cmd: 'python', args: ['-m', 'clang_format'] },
    { cmd: 'python3', args: ['-m', 'clang_format'] },
  ];
  for (const desc of candidates) {
    try { if (probe(desc)) return desc; } catch (_) {}
  }
  let extra = [];
  try { extra = scriptsDirs() || []; } catch (_) { extra = []; }
  for (const desc of extra) {
    try { if (probe(desc)) return desc; } catch (_) {}
  }
  return null;
}

/**
 * 按双保险顺序解析一个模块的入口绝对路径，找不到返回 null。
 * 顺序：(a) ${CLAUDE_PLUGIN_ROOT}/node_modules/<name>（打包的，本地/git 源装即用）
 *      (b) ${CLAUDE_PLUGIN_DATA}/node_modules/<name>（兜底，SessionStart 装的）
 * 用 require.resolve(paths) 让 Node 在指定目录树里解析。全程不抛。
 * @param {string} name 模块名
 * @returns {string|null} 解析到的入口路径
 */
function resolveModulePath(name) {
  const roots = [];
  if (PLUGIN_ROOT) roots.push(PLUGIN_ROOT);
  const dataDir = pluginDataDir();
  if (dataDir) roots.push(dataDir);
  for (const r of roots) {
    try {
      return require.resolve(name, { paths: [r] });
    } catch (_) {}
  }
  return null;
}

let _iconvCache; // undefined=未解析；null=确认不可用；object=模块
/**
 * 解析 iconv-lite 模块（双保险 ROOT→DATA），只解析不安装，结果缓存。
 * 供频繁调用的 bom_util 使用——轻量、不触发任何子进程。找不到返回 null（GBK 降级）。
 * @returns {object|null}
 */
function requireIconv() {
  if (_iconvCache !== undefined) return _iconvCache;
  const p = resolveModulePath('iconv-lite');
  let mod = null;
  if (p) {
    try { mod = require(p); } catch (_) { mod = null; }
  }
  _iconvCache = mod;
  return mod;
}

/**
 * 按需自举 iconv-lite。已装直接返回模块；缺失且未尝试过 → 安装一次（装到 PLUGIN_DATA）；
 * 仍失败 → 写失败标记并返回 null（降级：GBK 跳过）。全程不抛。
 *
 * 解析采用双保险：缺省模块名走 requireIconv（ROOT→DATA）；注入 moduleName 时按该名解析（测试用）。
 *
 * @param {object} [opts]
 * @param {string} [opts.moduleName] 注入测试用；缺省走 requireIconv 双保险解析
 * @param {string} [opts.marker] 失败标记路径，缺省 PLUGIN_DATA(或插件根) .iconv-install-failed
 * @param {function():boolean} [opts.install] 注入安装函数，缺省 npmInstall（装到 PLUGIN_DATA）
 * @returns {object|null}
 */
function ensureIconvLite(opts) {
  const o = opts || {};
  const marker = o.marker || markerPath('.iconv-install-failed');
  const install = o.install || npmInstall;

  // 注入了 moduleName → 按该名解析（测试用，可模拟“缺失”）；否则走双保险路径解析。
  const tryRequire = o.moduleName
    ? () => { try { return require(o.moduleName); } catch (_) { return null; } }
    : () => requireIconv();

  const found = tryRequire();
  if (found) return found;                 // 已装 → 不触发安装
  if (markerExists(marker)) return null;    // 曾失败 → 不重试

  let ok = false;
  try { ok = !!install(); } catch (_) { ok = false; }
  if (ok) {
    // 安装后清缓存重解析（PLUGIN_DATA 刚装上的）
    _iconvCache = undefined;
    const after = tryRequire();
    if (after) return after;
  }
  writeMarker(marker);
  return null;
}

/**
 * 按需自举 clang-format。检测到可用直接返回调用描述；缺失且未尝试过 → pip 安装一次；
 * 仍检测不到 → 写失败标记并返回 null（降级：clang-format 跳过）。全程不抛。
 *
 * @param {object} [opts]
 * @param {function():({cmd:string,args:string[]}|null)} [opts.detect] 注入检测函数，缺省 detectClangFormat
 * @param {string} [opts.marker] 失败标记路径，缺省插件根 .clang-format-install-failed
 * @param {function():boolean} [opts.install] 注入安装函数，缺省 pipInstallClangFormat
 * @returns {{cmd:string, args:string[]}|null}
 */
function ensureClangFormat(opts) {
  const o = opts || {};
  const marker = o.marker || markerPath('.clang-format-install-failed');
  const detect = o.detect || detectClangFormat;
  const install = o.install || pipInstallClangFormat;

  let desc = null;
  try { desc = detect(); } catch (_) { desc = null; }
  if (desc) return desc;                      // 已可用 → 不触发安装
  if (markerExists(marker)) return null;      // 曾失败 → 不重试

  let ok = false;
  try { ok = !!install(); } catch (_) { ok = false; }
  if (ok) {
    try { desc = detect(); } catch (_) { desc = null; }
    if (desc) return desc;
  }
  writeMarker(marker);
  return null;
}

/**
 * 后台 detached 预热子进程：跑本模块 CLI（prewarm 分支）执行两个 ensure。
 * 立即返回不阻塞调用方；子进程 unref 后独立存活；输出全部丢弃保持静默。
 * spawn 失败不抛，返回 null。
 * @returns {import('child_process').ChildProcess|null}
 */
function spawnPrewarm() {
  try {
    const child = spawn(process.execPath, [__filename, '--prewarm'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: isWindows,
    });
    child.unref();
    return child;
  } catch (_) {
    return null;
  }
}

module.exports = {
  ensureIconvLite,
  ensureClangFormat,
  markerPath,
  spawnPrewarm,
  detectClangFormat,
  requireIconv,
};

// CLI: 后台预热入口。仅做安装/检测，绝不输出。
if (require.main === module && process.argv.includes('--prewarm')) {
  try { ensureIconvLite(); } catch (_) {}
  try { ensureClangFormat(); } catch (_) {}
  process.exit(0);
}
