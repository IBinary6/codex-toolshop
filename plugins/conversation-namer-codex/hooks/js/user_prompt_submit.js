'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { validatedSessionId } = require('./lib/guidance');
const { readStdinJson } = require('./lib/protocol');
const { claimSession, readState, writeState } = require('./lib/state');
const { queueStartupObservation } = require('./startup_observer');

/** Pass the first message to the background naming process via stdin; inject no naming instructions into the main model. */
function queueNaming(input, {
  env = process.env, spawnWorker = spawn, observe = queueStartupObservation, now = Date.now,
} = {}) {
  const sessionId = validatedSessionId(input);
  if (!sessionId || env.CONVERSATION_NAMER_WORKER === '1') return;
  // SessionStart may be skipped or fail before registration (for example, an invalid launch cwd).
  // Verify the persisted first turn in the background
  // before creating state; never treat an arbitrary later prompt as permission to rename an old task.
  const state = readState(sessionId, env);
  if (!state) {
    if (typeof input.prompt === 'string' && input.prompt.trim() && input.prompt.length <= 20000) {
      observe(sessionId, { env, recovery: { prompt: input.prompt, observedAt: now() } });
    }
    return;
  }
  // The recovery observer owns the verified first prompt; a concurrent later hook must not replace it.
  if (state.recovered && state.status === 'pending') return;
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
