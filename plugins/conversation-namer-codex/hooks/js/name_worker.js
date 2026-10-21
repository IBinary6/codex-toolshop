'use strict';

const { readStdinJson } = require('./lib/protocol');
const { validatedSessionId } = require('./lib/guidance');
const { loadConfig, readState, writeState } = require('./lib/state');

/** Generate, verify, and write the current title; state stores neither user messages nor underlying service errors. */
async function nameSession(input, { env = process.env, clientFactory } = {}) {
  const sessionId = input && input.sessionId;
  if (!validatedSessionId({ session_id: sessionId })) return;
  const state = readState(sessionId, env);
  if (state?.status !== 'started') return;
  let client;
  try {
    const createClient = clientFactory || require('./lib/naming').createNamingClient;
    client = createClient(loadConfig(env));
    const result = await client.generateName({
      sessionId,
      prompt: input.prompt,
      ...(state.recovered ? { preserveExistingTitle: true } : {}),
    });
    if (result.skipped) {
      writeState(sessionId, { status: 'skipped', reason: result.skipped }, env);
      return;
    }
    const current = await client.readThreadName(sessionId);
    // A recovered task was accepted only while untitled. Preserve any title supplied during inference.
    if (state.recovered && current.originalTitle !== null && current.originalTitle !== '') {
      writeState(sessionId, { status: 'skipped', reason: 'existing_title' }, env);
      return;
    }
    // Notifications from an independent App Server do not reach the desktop connection; the current task uses the host tool to write.
    if (current.source === 'vscode') {
      writeState(sessionId, { status: 'ready', title: result.title, model: result.model,
        delivery: 'desktop' }, env);
      return;
    }
    if (current.originalTitle === result.title) {
      writeState(sessionId, { status: 'done', title: result.title, model: result.model }, env);
      return;
    }
    // Use the plugin result for first naming even if the host writes a default title while the model runs.
    await client.writeThreadName(sessionId, result.title);
    const verified = await client.readThreadName(sessionId);
    if (verified.originalTitle !== result.title) throw new Error('Title verification failed');
    writeState(sessionId, { status: 'done', title: result.title, model: result.model }, env);
  } catch (error) {
    const reason = /^(?:app_server|naming|invalid)_[a-z_]+$/.test(error.message)
      ? error.message : 'naming_failed';
    const diagnostic = {};
    // Store only known naming RPC names and numeric codes; raw service errors may contain secrets.
    if (['initialize', 'thread/read', 'model/list', 'config/read', 'thread/start',
      'turn/start', 'thread/name/set'].includes(error.rpcMethod)) diagnostic.rpcMethod = error.rpcMethod;
    if (Number.isInteger(error.rpcCode)) diagnostic.rpcCode = error.rpcCode;
    writeState(sessionId, { status: 'failed', reason, ...diagnostic }, env);
  } finally {
    if (client) await client.close();
  }
}

if (require.main === module) {
  nameSession(readStdinJson()).catch(() => { process.exitCode = 1; });
}

module.exports = { nameSession };
