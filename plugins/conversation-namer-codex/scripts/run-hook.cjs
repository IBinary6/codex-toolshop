'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = {
  session_start: path.join('hooks', 'js', 'session_start.js'),
  user_prompt_submit: path.join('hooks', 'js', 'user_prompt_submit.js'),
};

/**
 * 解析插件根目录，供 hook 子进程加载同一份实现与策略。
 *
 * @returns {string} 绝对插件根目录。
 * @example
 * const root = pluginRoot();
 */
function pluginRoot() {
  return process.env.PLUGIN_ROOT
    ? path.resolve(process.env.PLUGIN_ROOT)
    : path.resolve(__dirname, '..');
}

/**
 * 转发 JSONL hook 输入；子进程失败时保持 fail-open，不阻断用户请求。
 *
 * @returns {void}
 * @example
 * main();
 */
function main() {
  const hookName = process.argv[2];
  const relativePath = HOOKS[hookName];
  if (!relativePath) {
    process.stderr.write(`[conversation-namer-codex] unknown hook: ${hookName || '<missing>'}\n`);
    return;
  }

  const root = pluginRoot();
  let stdin = Buffer.alloc(0);
  try {
    stdin = fs.readFileSync(0);
  } catch (error) {
    process.stderr.write(`[conversation-namer-codex] hook setup failed: ${error.message}\n`);
    return;
  }

  const child = spawnSync(process.execPath, [path.join(root, relativePath)], {
    cwd: process.cwd(),
    env: { ...process.env, PLUGIN_ROOT: root },
    input: stdin,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: process.platform === 'win32',
  });
  if (child.error) {
    process.stderr.write(`[conversation-namer-codex] hook failed to start: ${child.error.message}\n`);
  } else if (child.status !== 0) {
    process.stderr.write(`[conversation-namer-codex] hook exited with status ${child.status}\n`);
  }
}

main();
