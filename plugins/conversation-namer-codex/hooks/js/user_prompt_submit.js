'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { validatedSessionId } = require('./lib/guidance');
const { readStdinJson } = require('./lib/protocol');
const { claimSession, writeState } = require('./lib/state');

/** 首条消息经 stdin 交给后台命名进程；不向主模型注入命名指令。 */
function queueNaming(input, { env = process.env, spawnWorker = spawn } = {}) {
  const sessionId = validatedSessionId(input);
  if (!sessionId || env.CONVERSATION_NAMER_WORKER === '1') return;
  if (!claimSession(sessionId, env)) return;
  const prompt = input.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    writeState(sessionId, { status: 'skipped', reason: 'empty_prompt' }, env);
    return;
  }
  const child = spawnWorker(process.execPath, [path.join(__dirname, 'name_worker.js')], {
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...env, CONVERSATION_NAMER_WORKER: '1' },
  });
  const failed = () => {
    writeState(sessionId, { status: 'failed', reason: 'worker_start_failed' }, env);
  };
  child.on('error', failed);
  child.stdin.on('error', failed);
  child.stdin.end(JSON.stringify({ sessionId, prompt }), () => child.unref());
}

if (require.main === module) {
  try { queueNaming(readStdinJson()); } catch (_) {
    process.stderr.write('[conversation-namer-codex] Automatic naming was skipped.\n');
  }
}

module.exports = { queueNaming };
