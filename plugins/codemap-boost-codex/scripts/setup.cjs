'use strict';

const fs = require('fs');
const path = require('path');

const {
  crgRuntimePaths,
  ensureCrg,
  ensureGraphify,
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
  startCrgBuild,
} = require('../hooks/js/lib/codemap');
const { markerPath, pluginDataDir } = require('../hooks/js/lib/runtime');

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
    '',
    'Options:',
    '  --with-graphify  Also install optional graphifyy package when graphify is missing.',
    '  --build          Start an initial code-review-graph build after setup.',
    '  --skip-install   Do not install packages; require an already healthy managed CRG runtime.',
  ].join('\n'));
}

function main() {
  if (args.has('--help') || args.has('-h')) {
    usage();
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
