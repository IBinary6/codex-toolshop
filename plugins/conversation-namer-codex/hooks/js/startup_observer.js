'use strict';

const { spawn } = require('child_process');
const { validatedSessionId } = require('./lib/guidance');
const { readStdinJson } = require('./lib/protocol');
const { armRecoveredSession, claimSession, loadConfig, readState } = require('./lib/state');
const { firstPrompt } = require('./lib/first_prompt');
const { nameSession } = require('./name_worker');

/** SessionStart only launches a lightweight background observer; it does not occupy the main model or wait for the first message. */
function queueStartupObservation(sessionId, { env = process.env, spawnWorker = spawn, recovery } = {}) {
  if (!validatedSessionId({ session_id: sessionId }) || env.CONVERSATION_NAMER_WORKER === '1') return;
  const child = spawnWorker(process.execPath, [__filename], {
    detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...env, CONVERSATION_NAMER_WORKER: '1' },
  });
  // Observer failure does not consume the naming opportunity; a normal UserPromptSubmit can still claim pending state.
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ sessionId, ...(recovery ? { recovery } : {}) }), () => child.unref());
}

/**
 * 漏掉 SessionStart 时只补注册可证明的新主会话。时间窗口以 hook 触发时刻固定，不随 RPC 重试延长。
 * null 表示首 turn 尚未持久化，false 表示不能安全补注册；已有标题即使像默认标题也不能猜测覆盖。
 */
function recoveryPrompt(thread, recovery) {
  const age = recovery.observedAt - thread.createdAt * 1000;
  if (!Number.isSafeInteger(thread.createdAt) || thread.createdAt <= 0
    || age < -999 || age > 5 * 60 * 1000
    || !['cli', 'vscode', 'exec', 'appServer'].includes(thread.source)
    || thread.ephemeral || thread.parentThreadId
    || (thread.name !== undefined && thread.name !== null && thread.name !== '')) return false;
  if (!Array.isArray(thread.turns) || thread.turns.length === 0) return null;
  if (thread.turns.length !== 1) return false;
  const items = thread.turns[0]?.items;
  if (!Array.isArray(items)) return null;
  const messages = items.filter((item) => item.type === 'userMessage');
  if (messages.length === 0) return null;
  if (messages.length !== 1) return false;
  const prompt = firstPrompt({ turns: [{ items: messages }] });
  if (prompt === null) return null;
  return prompt === recovery.prompt ? prompt : false;
}

/**
 * Wait for the current new task first request, including delegated input from create_thread.
 * Recovery first verifies the persisted task before registering it. Both paths share claimSession;
 * transient reads and an observation timeout never consume the naming opportunity.
 */
async function observeStartup(input, {
  env = process.env, clientFactory, timeoutMs = 60000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const sessionId = input?.sessionId;
  const recovery = input?.recovery;
  if (!validatedSessionId({ session_id: sessionId })) return 'inactive';
  const initialState = readState(sessionId, env);
  if (recovery) {
    if (initialState || typeof recovery.prompt !== 'string' || !recovery.prompt.trim()
      || recovery.prompt.length > 20000 || !Number.isSafeInteger(recovery.observedAt)
      || recovery.observedAt <= 0) return 'inactive';
  } else if (initialState?.status !== 'pending') return 'inactive';
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
      const state = readState(sessionId, env);
      if (recovery ? state !== null : state?.status !== 'pending') return 'claimed_elsewhere';
      let prompt = null;
      try {
        prompt = recovery ? recoveryPrompt(await client.readThread(sessionId), recovery)
          : await client.readFirstPrompt(sessionId);
      } catch (error) {
        // thread/read may temporarily return an RPC error before a new task first turn is persisted.
        if (error.message !== 'app_server_rpc_failed') return 'unavailable';
      }
      if (Date.now() >= deadline) break;
      if (prompt === false) return 'ineligible';
      if (prompt !== null) {
        if (recovery && !armRecoveredSession(sessionId, env)) return 'claimed_elsewhere';
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
