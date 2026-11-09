'use strict';

const { validatedSessionId } = require('./lib/guidance');
const { readStdinJson } = require('./lib/protocol');
const { claimStep, loadConfig, readState, writeState } = require('./lib/state');
const { writeDesktopTitle } = require('./lib/desktop_title');

function readyTitle(state) {
  return state?.status === 'ready' && state.delivery === 'desktop'
    && typeof state.firstTurnId === 'string' && state.firstTurnId.length > 0
    && typeof state.title === 'string' && state.title === state.title.trim()
    && [...state.title].length > 0 && [...state.title].length <= 120
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(state.title);
}

/**
 * 短回答在 Stop 投递首轮标题；后续轮次只按已确认的进展更新后缀。
 */
async function deliverAtStop(input, {
  env = process.env, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clientFactory, desktopWriter = writeDesktopTitle,
} = {}) {
  const sessionId = validatedSessionId(input);
  if (!sessionId || env.CONVERSATION_NAMER_WORKER === '1') return null;
  let state = readState(sessionId, env);
  if (['pending', 'started'].includes(state?.status)
      && claimStep(sessionId, 'desktop-wait', env)) {
    const deadline = now() + loadConfig(env).timeoutMs + 5000;
    while (['pending', 'started'].includes(state?.status) && now() < deadline) {
      await sleep(Math.min(250, deadline - now()));
      state = readState(sessionId, env);
    }
    if (['pending', 'started'].includes(state?.status)) {
      // 首轮等待结束，和正常投递共用同一个原子标记，防止迟到的结果在后续轮次改名。
      claimStep(sessionId, 'desktop-request', env);
      return null;
    }
  }
  if (state?.status === 'ready') {
    await deliverInitialTitle(sessionId, input.turn_id, state, { env, desktopWriter });
  } else if (state?.status === 'done') {
    const { refreshProgress } = require('./lib/progress');
    await refreshProgress(input, state, { env, clientFactory, desktopWriter });
  }
  return null;
}

async function deliverInitialTitle(sessionId, turnId, state, { env, desktopWriter }) {
  if (!readyTitle(state) || (turnId && turnId !== state.firstTurnId)
      || !claimStep(sessionId, 'desktop-request', env)) return;
  writeState(sessionId, { ...state, desktopSync: 'requested' }, env);
  if (await desktopWriter({ sessionId, turnId: state.firstTurnId, title: state.title }, { env })) {
    writeState(sessionId, { ...state, status: 'done', desktopSync: 'acknowledged' }, env);
  }
}

/** Deliver long tasks on the next tool return; Stop handles short answers without waiting on the tool path. */
async function deliverAfterTool(input, { env = process.env, desktopWriter = writeDesktopTitle } = {}) {
  const sessionId = validatedSessionId(input);
  if (!sessionId || env.CONVERSATION_NAMER_WORKER === '1') return null;
  await deliverInitialTitle(sessionId, input.turn_id, readState(sessionId, env), { env, desktopWriter });
  return null;
}

if (require.main === module) {
  const input = readStdinJson();
  Promise.resolve().then(() => input?.hook_event_name === 'PostToolUse'
    ? deliverAfterTool(input) : deliverAtStop(input)).catch(() => {});
}

module.exports = { deliverAtStop, deliverAfterTool };
