'use strict';

const { createHash } = require('crypto');
const { firstPrompt } = require('./first_prompt');
const { createNamingClient, PROGRESS_LABELS } = require('./naming');
const { claimStep, loadConfig, readState, writeState } = require('./state');

const PROGRESS_TIMEOUT_MS = 12000;

/** 只更新插件已确认写入的自动标题。每轮最多判断一次，超时或证据不全时保留标题。 */
async function refreshProgress(input, state, { env, clientFactory = createNamingClient }) {
  const sessionId = input.session_id;
  const turnId = input.turn_id;
  const response = input.last_assistant_message;
  if (state.progressDisabled || !state.baseTitle || !state.firstTurnId
      || input.stop_hook_active || typeof turnId !== 'string' || !turnId || turnId === state.firstTurnId
      || typeof response !== 'string' || !response.trim() || response.length > 20000) return null;

  const marker = createHash('sha256').update(turnId).digest('hex');
  if (!claimStep(sessionId, `progress-${marker}`, env)) return null;
  const settings = loadConfig(env);
  const client = clientFactory({ ...settings, timeoutMs: Math.min(settings.timeoutMs, PROGRESS_TIMEOUT_MS) });
  try {
    const [thread, turn] = await Promise.all([client.readThreadName(sessionId), client.readLatestTurn(sessionId)]);
    if (thread.originalTitle !== state.title || turn?.id !== turnId || !Array.isArray(turn.items)) return null;
    const request = firstPrompt({ turns: [{ items: [...turn.items].reverse() }] });
    if (!request?.trim() || request.length > 20000) return null;

    const stage = await client.classifyProgress({
      subject: state.baseTitle, previousStage: state.progressStage ?? null, request, response,
    });
    if (stage === state.progressStage || (stage !== 'disable' && !Object.hasOwn(PROGRESS_LABELS, stage))) return null;

    const [current, latest] = await Promise.all([client.readThreadName(sessionId), client.readLatestTurn(sessionId)]);
    if (current.originalTitle !== state.title || latest?.id !== turnId) return null;
    const saved = readState(sessionId, env);
    if (saved?.status !== 'done' || saved.title !== state.title || saved.progressDisabled) return null;
    if (stage === 'disable') {
      writeState(sessionId, { ...saved, progressDisabled: true, pendingProgress: undefined }, env);
      return null;
    }

    const label = PROGRESS_LABELS[stage][/\p{Script=Han}/u.test(state.baseTitle) ? 0 : 1];
    const title = `${state.baseTitle}\uff5c${label}`;
    if (current.source === 'vscode') {
      writeState(sessionId, { ...saved, pendingProgress: { title, stage, turnId } }, env);
      return title;
    }
    await client.writeThreadName(sessionId, title);
    if ((await client.readThreadName(sessionId)).originalTitle === title) {
      writeState(sessionId, { ...saved, title, progressStage: stage }, env);
    }
    return null;
  } catch {
    return null;
  } finally {
    await client.close();
  }
}

module.exports = { refreshProgress };
