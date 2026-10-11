'use strict';

const { SafeError } = require('./config.cjs');

// uvx prepares and starts the pinned official backend; this file loads only on an actual fetch call.
async function launch(provider, env, signal) {
  if (signal.aborted) throw new SafeError('Research Tools call was cancelled or timed out.');
  if (provider !== 'fetch') throw new SafeError('Invalid local Research Tools provider.');
  return { command: 'uvx', args: ['--from', 'mcp-server-fetch==2026.8.18', 'mcp-server-fetch'], env };
}

module.exports = { launch };
