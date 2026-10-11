'use strict';

const { spawn } = require('child_process');
const { validatedSessionId } = require('./lib/guidance');
const { readStdinJson } = require('./lib/protocol');
const { claimSession, loadConfig, readState } = require('./lib/state');
const { nameSession } = require('./name_worker');

/** SessionStart only launches a lightweight background observer; it does not occupy the main model or wait for the first message. */
function queueStartupObservation(sessionId, { env = process.env, spawnWorker = spawn } = {}) {
  if (!validatedSessionId({ session_id: sessionId }) || env.CONVERSATION_NAMER_WORKER === '1') return;
  const child = spawnWorker(process.execPath, [__filename], {
    detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...env, CONVERSATION_NAMER_WORKER: '1' },
  });
  // Observer failure does not consume the naming opportunity; a normal UserPromptSubmit can still claim pending state.
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ sessionId }), () => child.unref());
}

/**
 * Wait for the current new task first request, including delegated input from create_thread.
 * Both entry points share claimSession; a timeout ends observation but preserves naming for a later manual first message.
 */
async function observeStartup(input, {
  env = process.env, clientFactory, timeoutMs = 60000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const sessionId = input?.sessionId;
  if (!validatedSessionId({ session_id: sessionId })
    || readState(sessionId, env)?.status !== 'pending') return 'inactive';
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_observation_timeout');
  let client;
  let deadlineTimer;
  let handedOff = false;
  const deadline = Date.now() + timeoutMs;
  try {
    const settings = loadConfig(env);
    const createClient = clientFactory || require('./lib/naming').createNamingClient;
    client = createClient({ ...settings, timeoutMs: settings.timeoutMs + timeoutMs });
    deadlineTimer = setTimeout(() => { client.close().catch(() => {}); }, timeoutMs);
    let delay = 100;
    while (Date.now() < deadline) {
      if (readState(sessionId, env)?.status !== 'pending') return 'claimed_elsewhere';
      let prompt = null;
      try {
        prompt = await client.readFirstPrompt(sessionId);
      } catch (error) {
        // thread/read may temporarily return an RPC error before a new task first turn is persisted.
        if (error.message !== 'app_server_rpc_failed') return 'unavailable';
      }
      if (Date.now() >= deadline) break;
      if (prompt !== null) {
        if (!claimSession(sessionId, env)) return 'claimed_elsewhere';
        clearTimeout(deadlineTimer);
        deadlineTimer = setTimeout(() => { client.close().catch(() => {}); }, settings.timeoutMs);
        handedOff = true;
        await nameSession({ sessionId, prompt }, { env, clientFactory: () => client });
        return 'attempted';
      }
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 2, 2000);
    }
    return 'timeout';
  } finally {
    clearTimeout(deadlineTimer);
    if (client && !handedOff) await client.close();
  }
}

if (require.main === module) {
  observeStartup(readStdinJson()).catch(() => { process.exitCode = 1; });
}

module.exports = { observeStartup, queueStartupObservation };
