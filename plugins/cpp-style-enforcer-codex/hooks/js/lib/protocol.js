'use strict';

/**
 * 唯一输出出口。铁律：全程 exit 0；诊断走 stderr；stdout 要么空要么纯 JSON。
 * 永不 exit 1（issue #4809）、永不 exit 2+stdout JSON（旧崩溃源）。
 */

/** 静默通过：stdout/stderr 均空，exit 0 */
function passSilent() {
  process.exit(0);
}

/**
 * PostToolUse 强制修复：exit 0 + stdout {decision:"block",reason}
 * @param {string} reason 喂给 Claude 的修复指令
 */
function blockClaude(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

/**
 * PreToolUse 阻止工具：exit 0 + stdout hookSpecificOutput.permissionDecision=deny
 * @param {string} reason 阻止理由
 */
function denyTool(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

/** 诊断信息（用户/Claude 可见），绝不混入 stdout */
function diag(message) {
  process.stderr.write(String(message) + '\n');
}

module.exports = { passSilent, blockClaude, denyTool, diag };
