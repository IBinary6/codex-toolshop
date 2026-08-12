'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = {
  session_start: path.join('hooks', 'js', 'bugdb_python_check.js'),
  post_tool_use: path.join('hooks', 'js', 'bugdb_check.js'),
  user_prompt_submit: path.join('hooks', 'js', 'user_prompt_submit.js'),
};

function pluginRoot() {
  return path.resolve(process.env.PLUGIN_ROOT || path.join(__dirname, '..'));
}

function main() {
  /** 读取 Codex hook 输入并执行对应的本地脚本。 */
  const relative = HOOKS[process.argv[2]];
  if (!relative) return;
  let input = Buffer.alloc(0);
  try { input = fs.readFileSync(0); } catch (_) {}
  const root = pluginRoot();
  const child = spawnSync(process.execPath, [path.join(root, relative)], {
    cwd: process.cwd(),
    env: { ...process.env, PLUGIN_ROOT: root },
    input,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: process.platform === 'win32',
    timeout: 5000,
  });
  if (child.error) {
    // Hook 失败不可阻塞主流程；诊断留给显式 CLI 验证。
    process.exitCode = 0;
  }
}

main();
