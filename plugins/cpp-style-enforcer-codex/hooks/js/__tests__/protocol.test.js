const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const libPath = path.join(__dirname, '..', 'lib', 'protocol.js').replace(/\\/g, '/');
function runFn(call) {
  const r = spawnSync(process.execPath, ['-e', `const p = require(${JSON.stringify(libPath)}); ${call}`],
    { encoding: 'utf-8', timeout: 5000 });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

// passSilent: exit 0 with empty stdout and stderr.
let r = runFn('p.passSilent();');
assert.strictEqual(r.status, 0, 'passSilent exit 0');
assert.strictEqual(r.stdout, '', 'passSilent leaves stdout empty');
assert.strictEqual(r.stderr, '', 'passSilent leaves stderr empty');

r = runFn('p.addContext("PostToolUse", "FIX_THIS");');
assert.strictEqual(r.status, 0);
assert.strictEqual(r.stderr, '');
const context = JSON.parse(r.stdout);
assert.deepStrictEqual(Object.keys(context), ['hookSpecificOutput']);
assert.strictEqual(context.hookSpecificOutput.hookEventName, 'PostToolUse');
assert.match(context.hookSpecificOutput.additionalContext, /FIX_THIS/);

// denyTool: exit 0 with hookSpecificOutput.permissionDecision=deny on stdout.
r = runFn('p.denyTool("NO_COMMIT");');
assert.strictEqual(r.status, 0, 'denyTool exit 0');
const deny = JSON.parse(r.stdout);
assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny', 'permissionDecision=deny');
assert.strictEqual(deny.hookSpecificOutput.permissionDecisionReason, 'Staged C++ verification did not pass.');
assert.match(deny.hookSpecificOutput.additionalContext, /NO_COMMIT/);
console.log('protocol.test.js PASS');
