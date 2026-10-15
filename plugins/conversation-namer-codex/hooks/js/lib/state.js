'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { validatedSessionId } = require('./guidance');

/** Write plugin state only to the data directory, leaving installation and project files untouched. */
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

const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Windows briefly refuses to open or replace a file while another process is replacing or reading it. State files
 * are replaced by rename, so concurrent hooks hit this window; retry for about 50 ms before giving up.
 * @example retryTransient(() => fs.renameSync(temporary, file))
 */
function retryTransient(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!TRANSIENT_CODES.has(error.code) || attempt >= 10) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

function readState(sessionId, env = process.env) {
  try { return JSON.parse(retryTransient(() => fs.readFileSync(stateFile(sessionId, env), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeState(sessionId, value, env = process.env) {
  const file = stateFile(sessionId, env);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    retryTransient(() => fs.renameSync(temporary, file));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Register only once at startup; resume, compaction, and repeated startup do not reset naming state. */
function armSession(input, env = process.env) {
  const sessionId = validatedSessionId(input);
  if (!sessionId || input.source !== 'startup' || env.CONVERSATION_NAMER_WORKER === '1') return false;
  const file = stateFile(sessionId, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, JSON.stringify({ status: 'pending' }), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return false;
}

/** Atomically claim the first message; concurrent hooks, resume, and worker failures cannot trigger another model call. */
function claimSession(sessionId, env = process.env) {
  if (readState(sessionId, env)?.status !== 'pending') return false;
  try {
    const fd = fs.openSync(`${stateFile(sessionId, env)}.claimed`, 'wx', 0o600);
    fs.closeSync(fd);
  } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  writeState(sessionId, { status: 'started' }, env);
  return true;
}

/** 命名配置接受家族或精确型号及有界超时；默认跟随最新兼容 Luna，不改变全局模型。 */
function loadConfig(env = process.env) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(dataDirectory(env), 'config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const model = config.model === undefined ? 'luna' : config.model;
  const timeoutSeconds = config.timeoutSeconds === undefined ? 60 : config.timeoutSeconds;
  if (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(model)
      || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 120) {
    throw new Error('Invalid naming configuration');
  }
  return { model, timeoutMs: timeoutSeconds * 1000 };
}

module.exports = { dataDirectory, stateFile, readState, writeState, armSession, claimSession, loadConfig };
