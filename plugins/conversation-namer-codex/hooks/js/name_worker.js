'use strict';

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
    });
    if (result.skipped) {
      writeState(sessionId, { status: 'skipped', reason: result.skipped }, env);
      return;
    }
    const current = await client.readThreadName(sessionId);
    // 独立 App Server 的通知不会同步到桌面连接；由当前任务调用宿主工具完成写回。
    if (current.source === 'vscode') {
      writeState(sessionId, { status: 'ready', title: result.title, model: result.model,
        delivery: 'desktop' }, env);
      return;
    }
    if (current.originalTitle === result.title) {
      writeState(sessionId, { status: 'done', title: result.title, model: result.model }, env);
      return;
    }
    // 首次命名以插件结果为准；宿主可能在模型生成期间先写入默认标题。
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
