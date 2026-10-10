'use strict';

const { SafeError } = require('./config.cjs');

// uvx 按固定官方发行版准备并启动后端；只有实际 fetch 调用才会加载本文件。
async function launch(provider, env, signal) {
  if (signal.aborted) throw new SafeError('Research Tools 调用已取消或超时。');
  if (provider !== 'fetch') throw new SafeError('Research Tools 本地提供方无效。');
  return { command: 'uvx', args: ['--from', 'mcp-server-fetch==2026.8.18', 'mcp-server-fetch'], env };
}

module.exports = { launch };
