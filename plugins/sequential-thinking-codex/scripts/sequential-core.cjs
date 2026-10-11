'use strict';

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { SafeError } = require('./config.cjs');

// Match the pinned official index.js Zod registration layer: coerce numbers, strictly parse boolean strings, and strip unknown fields.
function parseArguments(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SafeError('Sequential Thinking arguments must be an object.');
  const result = {};
  for (const name of ['thought', 'branchId']) {
    if (name === 'branchId' && input[name] === undefined) continue;
    if (typeof input[name] !== 'string') throw new SafeError(`Sequential Thinking ${name} must be a string.`);
    result[name] = input[name];
  }
  for (const name of ['nextThoughtNeeded', 'isRevision', 'needsMoreThoughts']) {
    if (name !== 'nextThoughtNeeded' && input[name] === undefined) continue;
    const value = input[name];
    if (typeof value === 'boolean') result[name] = value;
    else if (typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase())) result[name] = value.toLowerCase() === 'true';
    else throw new SafeError(`Sequential Thinking ${name} must be a boolean or a true/false string.`);
  }
  for (const name of ['thoughtNumber', 'totalThoughts', 'revisesThought', 'branchFromThought']) {
    if (!['thoughtNumber', 'totalThoughts'].includes(name) && input[name] === undefined) continue;
    let value;
    try { value = Number(input[name]); } catch { throw new SafeError(`Sequential Thinking ${name} must be a positive integer.`); }
    if (!Number.isSafeInteger(value) || value < 1) throw new SafeError(`Sequential Thinking ${name} must be a positive integer.`);
    result[name] = value;
  }
  return result;
}

class SequentialCore {
  async start(signal) {
    if (signal.aborted || this.closed) throw new SafeError('Research Tools call was cancelled or timed out.');
    const { SequentialThinkingServer } = await import(pathToFileURL(path.join(__dirname, '../vendor/sequential-thinking/lib.js')).href);
    if (signal.aborted || this.closed) throw new SafeError('Research Tools call was cancelled or timed out.');
    this.core = new SequentialThinkingServer();
    // Use a public field of the official class to disable logging per instance without changing process-wide state or the official algorithm.
    this.core.disableThoughtLogging = true;
  }

  async request(method, params, signal) {
    if (signal.aborted || this.closed) throw new SafeError('Research Tools call was cancelled or timed out.');
    if (method === 'initialize') return { protocolVersion: params.protocolVersion, capabilities: { tools: {} } };
    if (method === 'notifications/initialized') return;
    if (method !== 'tools/call' || params?.name !== 'sequentialthinking' || !this.core) throw new SafeError('Invalid local Sequential Thinking call.');
    let parsed;
    try { parsed = parseArguments(params.arguments); }
    catch (error) { return { content: [{ type: 'text', text: error instanceof SafeError ? error.message : 'Invalid Sequential Thinking arguments.' }], isError: true }; }
    const result = this.core.processThought(parsed);
    if (result.isError) return result;
    return { content: result.content, structuredContent: JSON.parse(result.content[0].text) };
  }

  close() { this.closed = true; this.core = undefined; return Promise.resolve(); }
}

module.exports = { SequentialCore, parseArguments };
