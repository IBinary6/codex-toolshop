'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStdioRpc } = require('./app_server');
const { validatedSessionId } = require('./guidance');

function confirmedTitle(result, threadId, title) {
  if (!result || result.isError) return false;
  const candidates = [result.structuredContent, ...(result.content ?? [])];
  return candidates.some((value) => {
    if (value?.type === 'text') {
      try { value = JSON.parse(value.text); } catch { return false; }
    }
    return value?.threadId === threadId && value.title === title;
  });
}

/** 通过桌面自带的 MCP 服务更新当前对话。仅接受匹配的回执，连接失败时静默保留标题。 */
async function writeDesktopTitle({ sessionId, turnId, title }, {
  env = process.env, createRpc = createStdioRpc,
} = {}) {
  if (!validatedSessionId({ session_id: sessionId })
      || !validatedSessionId({ session_id: turnId })
      || typeof title !== 'string' || title !== title.trim() || !title
      || [...title].length > 120 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title)) return false;
  const endpoint = env.CODEX_APP_TOOLS_PIPE_PATH?.trim();
  if (!endpoint || !path.isAbsolute(endpoint)
      || (process.platform === 'win32' && !endpoint.toLowerCase().startsWith('\\\\.\\pipe\\'))) return false;
  const directory = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    '.tmp', 'bundled-marketplaces', 'openai-bundled', 'plugins', 'codex-app-tools');
  const server = path.join(directory, 'server.mjs');
  let rpc;
  try {
    if (!fs.statSync(server).isFile()) return false;
    const bundledNode = env.CODEX_MCP_NODE_PATH;
    const executable = bundledNode && path.isAbsolute(bundledNode) && fs.existsSync(bundledNode)
      ? bundledNode : process.execPath;
    rpc = createRpc(executable, [server], { cwd: directory, env, timeoutMs: 3000, jsonrpc: '2.0' });
    await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'conversation-namer', version: '1' } });
    rpc.notify('notifications/initialized');
    const result = await rpc.request('tools/call', {
      name: 'set_thread_title', arguments: { threadId: sessionId, title },
      _meta: { 'x-codex-turn-metadata': { thread_id: sessionId, turn_id: turnId } },
    });
    return confirmedTitle(result, sessionId, title);
  } catch {
    return false;
  } finally {
    await rpc?.close();
  }
}

module.exports = { writeDesktopTitle };
