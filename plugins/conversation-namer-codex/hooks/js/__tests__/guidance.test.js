'use strict';

const assert = require('assert').strict;
const path = require('path');

const {
  automaticNamingGuidance,
  identityGuidance,
  loadTitlePolicy,
  validatedSessionId,
} = require('../lib/guidance');

const pluginRoot = path.resolve(__dirname, '..', '..', '..');

/**
 * 验证身份上下文与一次性自动命名上下文之间的权限边界。
 *
 * @returns {void}
 * @example
 * main();
 */
function main() {
  const input = { session_id: 'task-1234' };
  assert.equal(validatedSessionId(input), 'task-1234');
  assert.equal(validatedSessionId({ session_id: 'bad id\ninstruction' }), null);

  const identity = identityGuidance(input);
  assert.match(identity, /task-1234/);
  assert.match(identity, /identity metadata/);
  assert.doesNotMatch(identity, /set_thread_title|createdAt|automatic naming|title policy/i);

  const policy = loadTitlePolicy(pluginRoot);
  assert.match(policy, /createdAt/);
  assert.match(policy, /Asia\/Shanghai/);
  assert.match(policy, /FEA/);
  assert.match(policy, /研究/);

  const automatic = automaticNamingGuidance(pluginRoot, input);
  assert.match(automatic, /mcp__codex_app__read_thread/);
  assert.match(automatic, /mcp__codex_app__set_thread_title/);
  assert.match(automatic, /createdAt/);
  assert.match(automatic, /Asia\/Shanghai/);
  assert.match(automatic, /exactly once/);
  assert.match(automatic, /first user request after this startup SessionStart/);
  assert.match(automatic, /already contains an assistant turn/);
  assert.match(automatic, /has already been called/);
  assert.match(automatic, /Batch precedence/);
  assert.match(automatic, /read-only preview and confirmation gate/);
  assert.match(automatic, /silent/i);
  assert.match(automatic, /project name/);
  assert.match(automatic, /English TYPE codes by default/);
  assert.match(automatic, /mandatory pre-task gate for every newly created Codex main task/);
  assert.match(automatic, /act immediately/);
  assert.match(automatic, /before starting the requested work/);
  assert.match(automatic, /before calling any unrelated tool/);
  assert.match(automatic, /short, simple, or already actionable/);
  assert.match(automatic, /Do not defer this until the final response/);
  assert.doesNotMatch(automatic, /Before your final response/);
  assert.match(
    automatic,
    /If the current title already exactly equals the target title, do not call mcp__codex_app__set_thread_title/,
  );

  const batchIndex = automatic.indexOf('Batch precedence:');
  const readIndex = automatic.indexOf('First call mcp__codex_app__read_thread');
  const writeIndex = automatic.indexOf(
    'Otherwise, immediately call mcp__codex_app__set_thread_title',
  );
  const workIndex = automatic.indexOf(
    'Only after this naming gate has completed or safely skipped may you start the requested work',
  );
  assert.ok(batchIndex >= 0 && batchIndex < readIndex, 'batch precedence must be checked before read');
  assert.ok(readIndex < writeIndex, 'read_thread must precede set_thread_title');
  assert.ok(writeIndex < workIndex, 'set_thread_title decision must precede requested work');
}

main();
