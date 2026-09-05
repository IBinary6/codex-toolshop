'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { validatedSessionId } = require('./guidance');

/** 插件状态只写入数据目录，不修改安装目录或项目文件。 */
function dataDirectory(env = process.env) {
  return env.PLUGIN_DATA ? path.resolve(env.PLUGIN_DATA)
    : path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      'plugins', 'data', 'conversation-namer-codex');
}

function stateFile(sessionId, env = process.env) {
  if (!validatedSessionId({ session_id: sessionId })) throw new Error('Invalid session id');
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(dataDirectory(env), 'sessions', `${key}.json`);
}

function readState(sessionId, env = process.env) {
  try { return JSON.parse(fs.readFileSync(stateFile(sessionId, env), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeState(sessionId, value, env = process.env) {
  fs.writeFileSync(stateFile(sessionId, env), JSON.stringify(value), { mode: 0o600 });
}

/** 仅 startup 登记一次；恢复、压缩及重复启动均不会重置命名状态。 */
function armSession(input, env = process.env) {
  const sessionId = validatedSessionId(input);
  if (!sessionId || input.source !== 'startup' || env.CONVERSATION_NAMER_WORKER === '1') return;
  const file = stateFile(sessionId, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, JSON.stringify({ status: 'pending' }), { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
}

/** 原子领取首条消息；并发 hook、恢复及 worker 失败都不会再次调用模型。 */
function claimSession(sessionId, env = process.env) {
  if (readState(sessionId, env)?.status !== 'pending') return false;
  try {
    const fd = fs.openSync(`${stateFile(sessionId, env)}.claimed`, 'wx', 0o600);
    fs.closeSync(fd);
  } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  writeState(sessionId, { status: 'started' }, env);
  return true;
}

/** 可选配置只接受模型名称及有界超时；不改变 Codex 全局配置。 */
function loadConfig(env = process.env) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(dataDirectory(env), 'config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const model = config.model === undefined ? 'auto' : config.model;
  const timeoutSeconds = config.timeoutSeconds === undefined ? 60 : config.timeoutSeconds;
  if (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(model)
      || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 120) {
    throw new Error('Invalid naming configuration');
  }
  return { model, timeoutMs: timeoutSeconds * 1000 };
}

module.exports = { dataDirectory, stateFile, readState, writeState, armSession, claimSession, loadConfig };
