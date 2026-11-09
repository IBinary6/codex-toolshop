'use strict';

const { createHash } = require('crypto');
const { latestPrompt } = require('./first_prompt');
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
    // 摘要保留普通用户消息，但省略桌面跟进消息的委托项。后者位于当前轮次开头。
    const request = latestPrompt(turn.items) ?? latestPrompt(await client.readTurnOpeningItems(sessionId, turnId));
    if (!request?.trim() || request.length > 20000) return null;

    const decision = await client.classifyProgress({
      subject: state.baseTitle, previousFocus: state.progressFocus ?? null,
      previousStage: state.progressStage ?? null, request, response,
    });
    if (!decision) return null;
    const previousFocus = state.progressFocus ?? '';
    const focus = decision.focus ?? previousFocus;
    const stage = decision.stage === 'keep'
      ? (focus === previousFocus ? state.progressStage : undefined) : decision.stage;
    if (focus === previousFocus && stage === state.progressStage) return null;

    const [current, latest] = await Promise.all([client.readThreadName(sessionId), client.readLatestTurn(sessionId)]);
    if (current.originalTitle !== state.title || latest?.id !== turnId) return null;
    const saved = readState(sessionId, env);
    if (saved?.status !== 'done' || saved.title !== state.title || saved.progressDisabled) return null;
    if (stage === 'disable') {
      writeState(sessionId, { ...saved, progressDisabled: true, pendingProgress: undefined }, env);
      return null;
    }

    const label = PROGRESS_LABELS[stage]?.[/\p{Script=Han}/u.test(state.baseTitle) ? 0 : 1];
    const suffix = [focus, label].filter(Boolean).join(' \u00b7 ');
    const title = suffix ? `${state.baseTitle} - ${suffix}` : state.baseTitle;
    if (current.source === 'vscode') {
      writeState(sessionId, { ...saved, pendingProgress: { title, focus, stage, turnId } }, env);
      return title;
    }
    await client.writeThreadName(sessionId, title);
    if ((await client.readThreadName(sessionId)).originalTitle === title) {
      writeState(sessionId, { ...saved, title, progressFocus: focus, progressStage: stage }, env);
    }
    return null;
  } catch {
    return null;
  } finally {
    await client.close();
  }
}

module.exports = { refreshProgress };
