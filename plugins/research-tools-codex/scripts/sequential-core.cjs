'use strict';

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { SafeError } = require('./config.cjs');

// 与固定官方 index.js 的 Zod 注册层一致：数值强制转换、布尔字符串严格转换、未知字段剔除。
function parseArguments(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SafeError('Sequential Thinking 参数必须是对象。');
  const result = {};
  for (const name of ['thought', 'branchId']) {
    if (name === 'branchId' && input[name] === undefined) continue;
    if (typeof input[name] !== 'string') throw new SafeError(`Sequential Thinking ${name} 必须是字符串。`);
    result[name] = input[name];
  }
  for (const name of ['nextThoughtNeeded', 'isRevision', 'needsMoreThoughts']) {
    if (name !== 'nextThoughtNeeded' && input[name] === undefined) continue;
    const value = input[name];
    if (typeof value === 'boolean') result[name] = value;
    else if (typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase())) result[name] = value.toLowerCase() === 'true';
    else throw new SafeError(`Sequential Thinking ${name} 必须是布尔值或 true/false 字符串。`);
  }
  for (const name of ['thoughtNumber', 'totalThoughts', 'revisesThought', 'branchFromThought']) {
    if (!['thoughtNumber', 'totalThoughts'].includes(name) && input[name] === undefined) continue;
    let value;
    try { value = Number(input[name]); } catch { throw new SafeError(`Sequential Thinking ${name} 必须是正整数。`); }
    if (!Number.isSafeInteger(value) || value < 1) throw new SafeError(`Sequential Thinking ${name} 必须是正整数。`);
    result[name] = value;
  }
  return result;
}

class SequentialCore {
  async start(signal) {
    if (signal.aborted || this.closed) throw new SafeError('Research Tools 调用已取消或超时。');
    const { SequentialThinkingServer } = await import(pathToFileURL(path.join(__dirname, '../vendor/sequential-thinking/lib.js')).href);
    if (signal.aborted || this.closed) throw new SafeError('Research Tools 调用已取消或超时。');
    this.core = new SequentialThinkingServer();
    // 官方类公开字段，只调整实例日志开关，不修改进程全局环境或官方算法。
    this.core.disableThoughtLogging = true;
  }

  async request(method, params, signal) {
    if (signal.aborted || this.closed) throw new SafeError('Research Tools 调用已取消或超时。');
    if (method === 'initialize') return { protocolVersion: params.protocolVersion, capabilities: { tools: {} } };
    if (method === 'notifications/initialized') return;
    if (method !== 'tools/call' || params?.name !== 'sequentialthinking' || !this.core) throw new SafeError('Sequential Thinking 本地调用无效。');
    let parsed;
    try { parsed = parseArguments(params.arguments); }
    catch (error) { return { content: [{ type: 'text', text: error instanceof SafeError ? error.message : 'Sequential Thinking 参数无效。' }], isError: true }; }
    const result = this.core.processThought(parsed);
    if (result.isError) return result;
    return { content: result.content, structuredContent: JSON.parse(result.content[0].text) };
  }

  close() { this.closed = true; this.core = undefined; return Promise.resolve(); }
}

module.exports = { SequentialCore, parseArguments };
