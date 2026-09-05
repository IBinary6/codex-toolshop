'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = path.resolve(__dirname, '..', '..', '..');
const runner = path.join(pluginRoot, 'scripts', 'run-hook.cjs');
const sessionStart = path.join(pluginRoot, 'hooks', 'js', 'session_start.js');

/**
 * 通过插件入口执行真实 SessionStart hook。
 *
 * @param {object} input JSONL 输入。
 * @returns {{stdout: string, stderr: string}} 标准输出与错误输出。
 * @example
 * const result = runHook({ source: 'startup', session_id: 'task-1' });
 */
function runHook(input) {
  const result = spawnSync(process.execPath, [runner, 'session_start'], {
    cwd: pluginRoot,
    env: { ...process.env, PLUGIN_ROOT: pluginRoot },
    input: JSON.stringify(input),
    encoding: 'utf8',
    windowsHide: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/**
 * 使用指定插件根直接执行 hook，用于验证策略文件异常时 fail-open。
 *
 * @param {object} input JSONL 输入。
 * @param {string} injectedRoot 注入给 hook 的插件根目录。
 * @returns {{stdout: string, stderr: string}} 标准输出与错误输出。
 * @example
 * const result = runDirect({ source: 'startup' }, '/missing/plugin');
 */
function runDirect(input, injectedRoot) {
  const result = spawnSync(process.execPath, [sessionStart], {
    cwd: pluginRoot,
    env: { ...process.env, PLUGIN_ROOT: injectedRoot },
    input: JSON.stringify(input),
    encoding: 'utf8',
    windowsHide: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/**
 * 解析必须存在的 JSONL hook 输出。
 *
 * @param {string} output 单行输出。
 * @returns {object} 已解析 hook 对象。
 * @example
 * const message = parseHookOutput('{"hookSpecificOutput":{}}');
 */
function parseHookOutput(output) {
  assert.ok(output, 'expected hook JSON output');
  return JSON.parse(output);
}

/**
 * 生成带平台元数据的 SessionStart 输入。
 *
 * @param {string} sessionId 当前会话 id。
 * @param {string} source SessionStart 来源。
 * @returns {object} 完整输入。
 * @example
 * const input = hookInput('task-1', 'startup');
 */
function hookInput(sessionId, source) {
  return {
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    transcript_path: path.join(pluginRoot, 'transcript.jsonl'),
    cwd: pluginRoot,
    source,
  };
}

/**
 * 验证 startup 单事件自动上下文、恢复事件身份上下文和异常降级。
 *
 * @returns {void}
 * @example
 * main();
 */
function main() {
  const startup = parseHookOutput(runHook(hookInput('task-startup', 'startup')).stdout);
  assert.equal(startup.hookSpecificOutput.hookEventName, 'SessionStart');
  const startupContext = startup.hookSpecificOutput.additionalContext;
  assert.match(startupContext, /task-startup/);
  assert.match(startupContext, /mcp__codex_app__read_thread/);
  assert.match(startupContext, /mcp__codex_app__set_thread_title/);
  assert.match(startupContext, /first user request after this startup SessionStart/);
  assert.match(startupContext, /already contains an assistant turn/);
  assert.match(startupContext, /has already been called/);
  assert.match(startupContext, /Batch precedence/);
  assert.match(startupContext, /do not automatically rename this task/);
  assert.match(startupContext, /conversation-title-manager/);
  assert.match(startupContext, /Keep automatic naming silent/);
  assert.match(startupContext, /mandatory pre-task gate for every newly created Codex main task/);
  assert.match(startupContext, /act immediately/);
  assert.match(startupContext, /before starting the requested work/);
  assert.match(startupContext, /before calling any unrelated tool/);
  assert.match(startupContext, /short, simple, or already actionable/);
  assert.match(startupContext, /Do not defer this until the final response/);
  assert.doesNotMatch(startupContext, /Before your final response/);
  assert.match(
    startupContext,
    /If the current title already exactly equals the target title, do not call mcp__codex_app__set_thread_title/,
  );

  const batchIndex = startupContext.indexOf('Batch precedence:');
  const readIndex = startupContext.indexOf('First call mcp__codex_app__read_thread');
  const writeIndex = startupContext.indexOf(
    'Otherwise, immediately call mcp__codex_app__set_thread_title',
  );
  const workIndex = startupContext.indexOf(
    'Only after this naming gate has completed or safely skipped may you start the requested work',
  );
  assert.ok(batchIndex >= 0 && batchIndex < readIndex, 'batch precedence must be checked before read');
  assert.ok(readIndex < writeIndex, 'read_thread must precede set_thread_title');
  assert.ok(writeIndex < workIndex, 'set_thread_title decision must precede requested work');

  for (const source of ['resume', 'clear', 'compact']) {
    const sessionId = `task-${source}`;
    const session = parseHookOutput(runHook(hookInput(sessionId, source)).stdout);
    assert.equal(session.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(session.hookSpecificOutput.additionalContext, new RegExp(sessionId));
    assert.doesNotMatch(
      session.hookSpecificOutput.additionalContext,
      /set_thread_title|createdAt|automatic naming|title policy|Batch precedence/i,
    );
  }

  assert.equal(runHook({ source: 'startup' }).stdout, '');
  assert.equal(runHook(hookInput('bad id\ninstruction', 'startup')).stdout, '');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-namer-missing-policy-'));
  try {
    const failedOpen = runDirect(hookInput('task-policy-missing', 'startup'), temporary);
    const identityOnly = parseHookOutput(failedOpen.stdout);
    assert.match(identityOnly.hookSpecificOutput.additionalContext, /task-policy-missing/);
    assert.doesNotMatch(identityOnly.hookSpecificOutput.additionalContext, /set_thread_title|createdAt/);
    assert.match(failedOpen.stderr, /SessionStart policy failed open/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main();
