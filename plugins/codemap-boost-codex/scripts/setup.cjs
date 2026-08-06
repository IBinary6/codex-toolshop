'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  crgRuntimePaths,
  ensureCrg,
  ensureGraphify,
  probeCrgRuntime,
} = require('../hooks/js/lib/bootstrap');
const {
  ENABLED_MARKER,
  enableCodeMap,
  ensureAgentsBlock,
  ensureGitignore,
  isCodeMapEnabled,
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  ensureCrgMcp,
  isCrgMcpConfigHealthy,
  parseMcpJson,
  runCodexMcp,
  startCrgBuild,
} = require('../hooks/js/lib/codemap');
const { codexHome, markerPath, pluginDataDir, repoRoot } = require('../hooks/js/lib/runtime');

const args = new Set(process.argv.slice(2));

function log(message) {
  process.stdout.write(`${message}\n`);
}

function warn(message) {
  process.stderr.write(`${message}\n`);
}

function removeMarker(name) {
  try {
    fs.rmSync(markerPath(name), { force: true });
  } catch (_) {}
}

function usage() {
  log([
    'CodeMap Boost setup',
    '',
    'Usage:',
    '  node scripts/setup.cjs [--with-graphify] [--build] [--skip-install]',
    '  node scripts/setup.cjs --doctor',
    '',
    'Options:',
    '  --with-graphify  Also install optional graphifyy package when graphify is missing.',
    '  --build          Start an initial code-review-graph build after setup.',
    '  --skip-install   Do not install packages; require an already healthy managed CRG runtime.',
    '  --doctor         Run read-only diagnostics; do not install, repair, build, or edit files.',
  ].join('\n'));
}

/**
 * 从 PATH 中解析当前实际使用的 Codex 命令路径。
 * @example resolveCommandOnPath('codex')
 */
function resolveCommandOnPath(command) {
  const directories = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const names = process.platform === 'win32'
    ? [command, ...suffixes.map((suffix) => `${command}${suffix.toLowerCase()}`)]
    : [command];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ''), name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (_) {}
    }
  }
  return null;
}

/**
 * 读取 MCP 配置而不执行 add/remove，保证 doctor 诊断不改变注册状态。
 * @example readMcpConfig(process.cwd())
 */
function readMcpConfig(cwd) {
  const result = runCodexMcp(['mcp', 'get', 'code-review-graph', '--json'], { cwd });
  const output = `${result && result.stdout ? result.stdout : ''}\n${result && result.stderr ? result.stderr : ''}`;
  return {
    ok: !!result && !result.error && result.status === 0,
    config: parseMcpJson(output),
  };
}

/**
 * 返回 MCP 当前配置的简短说明，不输出环境变量或其他敏感内容。
 * @example describeMcp({ transport: { command: 'uvx' } })
 */
function describeMcp(config, expected) {
  if (!config || typeof config !== 'object') return '未找到可解析的 code-review-graph MCP 配置';
  const transport = config.transport && typeof config.transport === 'object' ? config.transport : config;
  const type = typeof config.transport === 'string'
    ? config.transport
    : (transport.type || config.type || config.transport_type || '');
  const command = String(transport.command || config.command || '');
  const commandName = path.basename(command).toLowerCase();
  const currentArgs = Array.isArray(transport.args || config.args) ? (transport.args || config.args) : null;
  const cwd = Object.hasOwn(transport, 'cwd') ? transport.cwd : config.cwd;
  const issues = [];
  if (config.enabled !== true) issues.push('MCP 已禁用');
  if (String(type).toLowerCase() !== 'stdio') issues.push(`transport 应为 stdio，实际为 ${type || '<缺失>'}`);
  if (path.basename(command).toLowerCase() === 'uvx' || command.toLowerCase() === 'uvx') {
    issues.push('发现旧 uvx 注册；应迁移到插件私有运行时绝对路径');
  } else if (command !== expected.command) {
    issues.push(`命令应为 ${expected.command}，实际为 ${command || '<缺失>'}`);
  }
  if (!currentArgs || JSON.stringify(currentArgs) !== JSON.stringify(expected.args)) {
    issues.push(`参数应为 ${JSON.stringify(expected.args)}，实际为 ${JSON.stringify(currentArgs)}`);
  }
  if (cwd !== null) issues.push(`不应设置固定 cwd，实际为 ${JSON.stringify(cwd)}`);
  return issues.length > 0 ? issues.join('；') : `配置精确匹配：${commandName || command}`;
}

/**
 * 执行只读健康检查并用退出码表达是否需要修复。
 * @example runDoctor(process.cwd())
 */
function runDoctor(cwd) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const home = codexHome();
  const data = pluginDataDir();
  const managed = crgRuntimePaths();
  const root = repoRoot(cwd);
  const codexPath = resolveCommandOnPath('codex');
  const codexVersion = runCodexMcp(['--version'], { cwd });
  const codexOk = !!codexVersion && !codexVersion.error && codexVersion.status === 0;
  const versionText = String(codexVersion && codexVersion.stdout ? codexVersion.stdout : '').trim();
  const runtimeDiagnostics = [];
  const runtimeOk = probeCrgRuntime({ diagnostics: runtimeDiagnostics });
  const mcp = readMcpConfig(cwd);
  const mcpOk = mcp.ok && isCrgMcpConfigHealthy(mcp.config, {
    command: managed.command,
    args: ['serve'],
  });
  const graphDir = root ? path.join(root, '.code-review-graph') : null;
  const graphExists = !!graphDir && fs.existsSync(graphDir);
  let graphStatusOk = false;
  if (runtimeOk && root && graphExists) {
    const status = spawnSync(managed.command, ['status'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
      windowsHide: process.platform === 'win32',
    });
    graphStatusOk = !status.error && status.status === 0;
  }

  log('CodeMap Boost doctor（只读诊断）');
  log(`插件版本:          ${packageJson.version}`);
  log(`Codex CLI:         ${codexOk ? 'PASS' : 'FAIL'}  ${codexPath || 'PATH 中未找到'}${versionText ? ` (${versionText})` : ''}`);
  log(`CODEX_HOME:        ${home}`);
  log(`插件数据目录:      ${data}`);
  log(`私有运行时:        ${runtimeOk ? 'PASS' : 'FAIL'}  ${managed.command}`);
  if (!runtimeOk && runtimeDiagnostics.length > 0) log(`运行时诊断:        ${runtimeDiagnostics.slice(-2).join('；')}`);
  log(`MCP 注册:          ${mcpOk ? 'PASS' : 'FAIL'}  ${describeMcp(mcp.config, { command: managed.command, args: ['serve'] })}`);
  log(`目标 Git 仓库:     ${root ? `PASS  ${root}` : 'WARN  当前目录不在 Git 仓库中'}`);
  log(`项目图谱:          ${graphStatusOk ? 'PASS' : graphExists ? 'WARN  图谱存在但 status 检查失败' : 'WARN  尚未找到图谱目录'}`);
  log('当前任务工具:      UNKNOWN  CLI 无法读取已启动任务的工具快照，请在新任务中确认 mcp__code_review_graph__ 工具。');

  const needsRepair = !codexOk || !runtimeOk || !mcpOk;
  const needsProject = !root;
  const needsBuild = !!root && !graphStatusOk;
  log('建议:');
  if (!codexOk) log('  - 安装或修复 Codex CLI，并确认运行 `codex --version` 成功；setup 无法安装 Codex CLI。');
  if (needsProject) log('  - 切换到目标 Git 仓库目录后重新运行 --doctor；不要在插件目录或普通目录构建项目图谱。');
  if (codexOk && runtimeOk && !mcpOk) log(`  - 在目标仓库修复 MCP：node "${path.join(__dirname, 'setup.cjs')}" --build`);
  else if (!runtimeOk && codexOk) log(`  - 在目标仓库重建私有运行时：node "${path.join(__dirname, 'setup.cjs')}" --build`);
  else if (codexOk && runtimeOk && mcpOk && needsBuild) log(`  - MCP 已就绪；运行：node "${path.join(__dirname, 'setup.cjs')}" --build`);
  if (!mcpOk || needsRepair) log('  - 修复后完整退出 Codex，并创建一个全新任务；旧任务不会动态补载 MCP 工具。');
  else log('  - 注册状态正常；若当前任务没有图工具，请完整重启 Codex 后创建新任务。');
  const finalStatus = needsRepair ? 'NEEDS_REPAIR' : needsProject ? 'NEEDS_PROJECT' : needsBuild ? 'NEEDS_BUILD' : 'READY';
  log(`最终状态:          ${finalStatus}`);
  process.exitCode = finalStatus === 'READY' ? 0 : 1;
}

function main() {
  if (args.has('--help') || args.has('-h')) {
    usage();
    return;
  }

  if (args.has('--doctor')) {
    const incompatible = [...args].filter((arg) => arg !== '--doctor');
    if (incompatible.length > 0) {
      warn(`[codemap-boost-codex] --doctor 不能与 ${incompatible.join('、')} 同时使用；诊断模式必须保持只读。`);
      process.exitCode = 2;
      return;
    }
    runDoctor(process.cwd());
    return;
  }

  log(`[codemap-boost-codex] plugin data: ${pluginDataDir()}`);

  removeMarker('.crg-install-failed');
  removeMarker('.crg-codex-register-failed');
  removeMarker('.codemap-bootstrap-failed');
  if (args.has('--with-graphify')) removeMarker('.graphify-install-failed');

  const crgOk = args.has('--skip-install')
    ? (process.env.CODEMAP_BOOST_ASSUME_CRG === '1' || ensureCrg({ installRuntime: () => false }))
    : ensureCrg();
  if (!crgOk) {
    warn('[codemap-boost-codex] 插件私有 code-review-graph 运行环境不可用或 parser 健康检查失败。');
    warn('[codemap-boost-codex] 请不要使用 pip --user 修补；直接重新运行 setup 让插件重建隔离环境。');
    process.exit(1);
  }
  log(`[codemap-boost-codex] managed runtime: ${crgRuntimePaths().command}`);

  const mcp = ensureCrgMcp({ cwd: process.cwd() });
  if (!mcp.ok) {
    warn(`[codemap-boost-codex] ${mcp.diagnostic || 'code-review-graph MCP registration failed.'}`);
    process.exitCode = 1;
    return;
  }
  if (mcp.changed) {
    log('[codemap-boost-codex] code-review-graph MCP 已注册或修复；请新开一个 Codex 任务使当前会话加载新配置。');
  }

  if (args.has('--with-graphify') && !ensureGraphify()) {
    warn('[codemap-boost-codex] optional graphify setup failed; CodeMap Boost will continue without graphify.');
  }

  enableCodeMap();
  cleanLegacyCrgHooks();
  cleanLegacyCrgGitHook(process.cwd());
  ensureAgentsBlock();
  ensureGitignore(process.cwd());

  if (args.has('--build')) {
    if (startCrgBuild(process.cwd())) {
      log('[codemap-boost-codex] initial graph build started in the background.');
    } else {
      log('[codemap-boost-codex] initial graph build was skipped; graph may already exist or this is not a Git repo.');
    }
  }

  log(`[codemap-boost-codex] enabled marker: ${path.basename(markerPath(ENABLED_MARKER))}`);
  if (isCodeMapEnabled()) log('[codemap-boost-codex] setup complete.');
}

main();
