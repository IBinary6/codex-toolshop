'use strict';

const path = require('path');
const { readStdinJson } = require('./lib/protocol');
const { validatedSessionId } = require('./lib/guidance');
const { loadConfig, readState, writeState } = require('./lib/state');

/** 生成、复核并写回当前标题；状态不保存用户消息或底层服务错误。 */
async function nameSession(input, { env = process.env, clientFactory } = {}) {
  const sessionId = input && input.sessionId;
  if (!validatedSessionId({ session_id: sessionId })
      || readState(sessionId, env)?.status !== 'started') return;
  let client;
  try {
    const createClient = clientFactory || require('./lib/naming').createNamingClient;
    client = createClient(loadConfig(env));
    const result = await client.generateName({
      sessionId,
      prompt: input.prompt,
      pluginRoot: env.PLUGIN_ROOT || path.resolve(__dirname, '..', '..'),
    });
    if (result.skipped) {
      writeState(sessionId, { status: 'skipped', reason: result.skipped }, env);
      return;
    }
    const current = await client.readThreadName(sessionId);
    if (current.originalTitle === result.title) {
      writeState(sessionId, { status: 'done', title: result.title, model: result.model }, env);
      return;
    }
    if (current.originalTitle !== result.originalTitle) {
      writeState(sessionId, { status: 'skipped', reason: 'title_changed' }, env);
      return;
    }
    await client.writeThreadName(sessionId, result.title);
    const verified = await client.readThreadName(sessionId);
    if (verified.originalTitle !== result.title) throw new Error('Title verification failed');
    writeState(sessionId, { status: 'done', title: result.title, model: result.model }, env);
  } catch (error) {
    const reason = /^(?:app_server|naming|invalid)_[a-z_]+$/.test(error.message)
      ? error.message : 'naming_failed';
    writeState(sessionId, { status: 'failed', reason }, env);
  } finally {
    if (client) await client.close();
  }
}

if (require.main === module) {
  nameSession(readStdinJson()).catch(() => { process.exitCode = 1; });
}

module.exports = { nameSession };
