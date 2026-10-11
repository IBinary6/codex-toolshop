'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = {
  session_start: path.join('hooks', 'js', 'session_start.js'),
  user_prompt_submit: path.join('hooks', 'js', 'user_prompt_submit.js'),
  pre_tool_use: path.join('hooks', 'js', 'pre_tool_use.js'),
  subagent_start: path.join('hooks', 'js', 'subagent_start.js'),
};

function pluginRoot() {
  return process.env.PLUGIN_ROOT
    ? path.resolve(process.env.PLUGIN_ROOT)
    : path.resolve(__dirname, '..');
}

function pluginDataDir() {
  if (process.env.PLUGIN_DATA) return path.resolve(process.env.PLUGIN_DATA);
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'plugins', 'data', 'agent-dispatch-codex');
}

function main() {
  const hook = process.argv[2];
  const relative = HOOKS[hook];
  if (!relative) {
    process.stderr.write(`[agent-dispatch-codex] unknown hook: ${hook || '<missing>'}\n`);
    return;
  }
  const root = pluginRoot();
  const data = pluginDataDir();
  try { fs.mkdirSync(data, { recursive: true }); } catch (_) {}
  let stdin = Buffer.alloc(0);
  try { stdin = fs.readFileSync(0); } catch (_) {}
  const child = spawnSync(process.execPath, [path.join(root, relative)], {
    cwd: process.cwd(),
    env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data },
    input: stdin,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: process.platform === 'win32',
  });
  if (child.error) {
    process.stderr.write(`[agent-dispatch-codex] hook failed to start: ${child.error.message}\n`);
  }
}

main();
