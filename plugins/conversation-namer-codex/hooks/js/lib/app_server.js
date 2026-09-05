'use strict';

const { spawn } = require('child_process');

const DISABLED_FEATURES = [
  'hooks', 'plugins', 'apps', 'shell_tool', 'memories', 'multi_agent',
  'browser_use', 'computer_use', 'image_generation', 'view_image',
  'code_mode_host', 'unified_exec',
];

/** 返回只应用于命名子进程的配置，不修改用户配置或认证。 */
function isolatedConfig() {
  return {
    ...Object.fromEntries(DISABLED_FEATURES.map((feature) => [`features.${feature}`, false])),
    project_doc_max_bytes: 0,
    web_search: 'disabled',
  };
}

/**
 * 启动受总超时约束的 stdio JSON-RPC 客户端。
 * 服务端请求一律拒绝；错误只暴露本地错误码，避免转发服务端敏感文本。
 * 调用者必须 await close() 回收子进程；spawnImpl 仅供测试替换进程。
 */
function createAppServer({ cwd, timeoutMs = 60000, command = 'codex', spawnImpl = spawn } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_timeout');
  const args = ['app-server'];
  for (const [key, value] of Object.entries(isolatedConfig())) {
    args.push('-c', `${key}=${JSON.stringify(value)}`);
  }
  const child = spawnImpl(command, args, {
    cwd,
    env: { ...process.env, CONVERSATION_NAMER_WORKER: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  const notifications = new Set();
  const failures = new Set();
  let sequence = 0;
  let buffer = '';
  let failure = null;
  let exited = false;
  let closing = null;
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });

  function abort(code) {
    if (failure) return;
    failure = new Error(code);
    clearTimeout(deadline);
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
    for (const listener of failures) listener(failure);
    child.kill();
  }

  const deadline = setTimeout(() => abort('app_server_timeout'), timeoutMs);
  child.once('error', () => {
    abort('app_server_unavailable');
    if (!child.pid) {
      exited = true;
      resolveExit();
    }
  });
  child.once('exit', () => {
    exited = true;
    resolveExit();
    abort('app_server_exited');
  });
  child.stdin.on('error', () => abort('app_server_write_failed'));
  child.stdout.setEncoding('utf8');
  // 只消费 stderr；命名后台不记录可能包含 provider 详情的诊断。
  child.stderr.resume();

  function send(message) {
    if (failure) throw failure;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  child.stdout.on('data', (chunk) => {
    if (failure) return;
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) return abort('app_server_output_too_large');
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return abort('app_server_invalid_json');
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return abort('app_server_invalid_message');
      }
      if (typeof message.method === 'string') {
        if (Object.hasOwn(message, 'id')) {
          send({ id: message.id, error: { code: -32601, message: 'Naming does not allow server requests.' } });
          return abort('app_server_request_rejected');
        }
        for (const listener of notifications) listener(message.method, message.params || {});
      } else if (pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error('app_server_rpc_failed'));
        else if (Object.hasOwn(message, 'result')) resolve(message.result);
        else reject(new Error('app_server_invalid_response'));
      }
      if (failure) return;
    }
  });

  return {
    request(method, params = {}) {
      if (failure) return Promise.reject(failure);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          send({ id, method, params });
        } catch {
          abort('app_server_write_failed');
        }
      });
    },
    notify(method, params) { send({ method, ...(params === undefined ? {} : { params }) }); },
    onNotification(listener) {
      notifications.add(listener);
      return () => notifications.delete(listener);
    },
    onFailure(listener) {
      if (failure) listener(failure);
      else failures.add(listener);
      return () => failures.delete(listener);
    },
    abort,
    close() {
      if (closing) return closing;
      closing = (async () => {
        abort('app_server_closed');
        child.stdin.end();
        if (!exited) {
          const force = setTimeout(() => child.kill('SIGKILL'), 250);
          const stopWaiting = setTimeout(resolveExit, 1000);
          await exit;
          clearTimeout(force);
          clearTimeout(stopWaiting);
        }
        child.stdout.destroy();
        child.stderr.destroy();
        notifications.clear();
        failures.clear();
      })();
      return closing;
    },
  };
}

module.exports = { createAppServer, isolatedConfig };
