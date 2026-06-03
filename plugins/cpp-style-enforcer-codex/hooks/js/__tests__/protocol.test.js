const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const libPath = path.join(__dirname, '..', 'lib', 'protocol.js').replace(/\\/g, '/');
const runnerDir = path.join(__dirname, 'fixtures');
fs.mkdirSync(runnerDir, { recursive: true });

function runFn(call) {
  const runner = path.join(runnerDir, 'protocol-runner.js');
  fs.writeFileSync(runner, `const p = require('${libPath}'); ${call}`);
  const r = spawnSync('node', [runner], { encoding: 'utf-8', timeout: 5000 });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

// passSilent: exit0, stdout 空, stderr 空
let r = runFn('p.passSilent();');
assert.strictEqual(r.status, 0, 'passSilent exit 0');
assert.strictEqual(r.stdout, '', 'passSilent stdout 空');
assert.strictEqual(r.stderr, '', 'passSilent stderr 空');

// blockClaude: exit0, stdout 是 {decision:block,reason}
r = runFn('p.blockClaude("FIX_THIS");');
assert.strictEqual(r.status, 0, 'blockClaude exit 0');
const block = JSON.parse(r.stdout);
assert.strictEqual(block.decision, 'block', 'decision=block');
assert.strictEqual(block.reason, 'FIX_THIS', 'reason 透传');

// denyTool: exit0, stdout 是 hookSpecificOutput.permissionDecision=deny
r = runFn('p.denyTool("NO_COMMIT");');
assert.strictEqual(r.status, 0, 'denyTool exit 0');
const deny = JSON.parse(r.stdout);
assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny', 'permissionDecision=deny');
assert.strictEqual(deny.hookSpecificOutput.permissionDecisionReason, 'NO_COMMIT', 'reason 透传');
console.log('protocol.test.js PASS');
