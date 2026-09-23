'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pluginDataDir } = require('../hooks/js/lib/runtime');

// MCP 常驻进程不能以可被宿主替换的插件缓存为工作目录。
function enterMcpDataDir(options = {}) {
  for (const name of ['CODEX_HOME', 'PLUGIN_DATA']) {
    if (process.env[name]) process.env[name] = path.resolve(process.env[name]);
  }
  if (process.env.CODEMAP_BOOST_PYTHON && /[\\/]/.test(process.env.CODEMAP_BOOST_PYTHON)) {
    process.env.CODEMAP_BOOST_PYTHON = path.resolve(process.env.CODEMAP_BOOST_PYTHON);
  }
  const resolved = { ...options };
  for (const name of ['codexHome', 'pluginRoot']) {
    if (resolved[name]) resolved[name] = path.resolve(resolved[name]);
  }
  resolved.pluginDataDir = path.resolve(options.pluginDataDir || pluginDataDir(resolved));
  fs.mkdirSync(resolved.pluginDataDir, { recursive: true });
  process.chdir(resolved.pluginDataDir);
  return resolved;
}

module.exports = { enterMcpDataDir };
