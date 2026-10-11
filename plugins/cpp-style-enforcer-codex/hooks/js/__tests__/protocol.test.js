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

// passSilent: exit 0 with empty stdout and stderr.
let r = runFn('p.passSilent();');
assert.strictEqual(r.status, 0, 'passSilent exit 0');
assert.strictEqual(r.stdout, '', 'passSilent leaves stdout empty');
assert.strictEqual(r.stderr, '', 'passSilent leaves stderr empty');

// blockCodex: exit 0 with {decision:block,reason} on stdout.
r = runFn('p.blockCodex("FIX_THIS");');
assert.strictEqual(r.status, 0, 'blockCodex exit 0');
const block = JSON.parse(r.stdout);
assert.strictEqual(block.decision, 'block', 'decision=block');
assert.strictEqual(block.reason, 'FIX_THIS', 'Preserves the reason');

// denyTool: exit 0 with hookSpecificOutput.permissionDecision=deny on stdout.
r = runFn('p.denyTool("NO_COMMIT");');
assert.strictEqual(r.status, 0, 'denyTool exit 0');
const deny = JSON.parse(r.stdout);
assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny', 'permissionDecision=deny');
assert.strictEqual(deny.hookSpecificOutput.permissionDecisionReason, 'NO_COMMIT', 'Preserves the reason');
console.log('protocol.test.js PASS');
